const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const { spawnSync } = require('child_process');
const path = require('path');
const db = require('../src/config/db');
const orgs = require('../src/services/courierOrganizations.service');
const runs = require('../src/services/payrollRuns.service');
const { runIntegrityChecks, GUARD_TRIGGERS, NOT_APPLICABLE } = require('../src/integrity/checks');
const { runNightlyIntegrity, msUntilNextRun } = require('../src/integrity/job');

let token; let product; let storeId; let staffId; let repId; let phoneSeq = 0;
const auth = (r) => r.set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  token = await loginAsAdmin();
  const me = db.prepare(`SELECT id, store_id FROM users WHERE email = 'admin@urbantrends.com'`).get();
  staffId = me.id; storeId = me.store_id;
  product = (await auth(request(app).get('/api/products?pageSize=25'))).body.data.find((p) => p.sell_price < 500000);
  const rep = await auth(request(app).post('/api/staff')).send({ name: 'Integrity Rep', email: 'integrityrep@urbantrends.com', phone: '0722100888', password: 'Marble-Thistle-4678', role: 'cashier' });
  repId = rep.body.data.id;
});
afterAll(() => cleanupTestDb());

async function newOrder({ courierId, fee, assign = true } = {}) {
  const phone = `07660${String(++phoneSeq).padStart(5, '0')}`;
  const created = await auth(request(app).post('/api/orders')).send({
    name: `Integrity ${phoneSeq}`, phone, city: 'Nairobi', payment_type: courierId ? 'cod' : 'prepaid', ...(assign ? { assigned_staff_id: repId } : {}),
    items: [{ product_id: product.id, quantity: 1 }],
  });
  expect(created.status).toBe(201);
  const id = created.body.data.id;
  if (courierId) {
    await auth(request(app).post(`/api/orders/${id}/courier`)).send({ courier_id: courierId });
    await auth(request(app).post(`/api/orders/${id}/confirm-cod`));
  }
  const res = await auth(request(app).post(`/api/orders/${id}/dispatch`)).send(fee === undefined ? {} : { package_fee: fee });
  expect(res.status).toBe(200);
  return { id, total: created.body.data.total, code: db.prepare('SELECT product_code FROM orders WHERE id = ?').get(id).product_code };
}
const pay = (o, amount, method = 'mobile_money') => auth(request(app).post(`/api/orders/${o.id}/payments`)).send({ method, amount, reference: `I${o.id}${method}` });
const violations = (rule) => runIntegrityChecks().violations.filter((v) => v.rule === rule);
const checks = (rule) => violations(rule).map((v) => v.check);

// Damage the data the way a bypassed guard would, run `fn`, and always put it back.
function tamper(sql, restoreSql, fn) {
  db.exec(sql);
  try { return fn(); } finally { db.exec(restoreSql); }
}
function withoutTrigger(name, fn) {
  const { sql } = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(name);
  db.exec(`DROP TRIGGER ${name}`);
  try { return fn(); } finally { db.exec(sql); }
}

describe('a healthy shop passes every check', () => {
  it('passes on a realistic mix: paid, part paid, refunded, shop cash, an organization, a locked payroll run', async () => {
    const paid = await newOrder(); await pay(paid, paid.total);
    const part = await newOrder(); await pay(part, Math.floor(part.total / 2));
    const refunded = await newOrder(); const r = await pay(refunded, refunded.total);
    const paymentId = db.prepare('SELECT id FROM payment_records WHERE order_id = ?').get(refunded.id).id;
    expect((await auth(request(app).post(`/api/payments/${paymentId}/refund`))).status).toBe(200);

    const cash = await newOrder();
    expect((await auth(request(app).post(`/api/orders/${cash.id}/shop-cash`)).send({ amount: cash.total, reason: 'Walked in' })).status).toBeLessThan(300);
    const custodyId = db.prepare('SELECT id FROM custody_records WHERE order_id = ?').get(cash.id).id;
    await auth(request(app).post(`/api/custody/${custodyId}/deposit`));

    const org = (await auth(request(app).post('/api/couriers')).send({ name: `Org ${Date.now()}`, kind: 'organization', collects_payment: true })).body.data;
    const viaOrg = await newOrder({ courierId: org.id, fee: 20_000, assign: true });
    const col = orgs.recordCollection({ storeId, staffId, courierId: org.id, orderId: viaOrg.id, amount: viaOrg.total });
    orgs.createStatement({ storeId, staffId, courierId: org.id, periodStart: '2026-01-01', periodEnd: '2026-12-31', collectionIds: [col.id],
      chargeEntered: 20_000, remitted: viaOrg.total - 20_000, remittanceRef: 'RMT1' });

    const today = require('../src/utils/storeTime').localDate();
    runs.generateDraft({ storeId, from: today, to: today, staffId });
    const draft = db.prepare(`SELECT id FROM payroll_runs WHERE status = 'draft'`).get();
    runs.approveRun({ runId: draft.id, storeId, staffId });

    expect(db.prepare('SELECT COUNT(*) AS n FROM commissioned_orders').get().n).toBeGreaterThan(0);
    const report = runIntegrityChecks();
    expect(report.violations).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts.orders).toBeGreaterThanOrEqual(5);
    expect(report.notApplicable.map((n) => n.rule)).toEqual([1, 3, 4, 5]);
  });

  it('every guard trigger it expects really exists', () => {
    const present = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all().map((r) => r.name));
    for (const g of GUARD_TRIGGERS) expect(present.has(g.trigger), g.trigger).toBe(true);
    expect(NOT_APPLICABLE).toHaveLength(4);
  });
});

describe('rule 2: the paid amount comes from the payments', () => {
  it('flags an order whose paid counter was edited by hand', async () => {
    const o = await newOrder(); await pay(o, o.total);
    tamper(`UPDATE orders SET amount_paid = 1 WHERE id = ${o.id}`, `UPDATE orders SET amount_paid = ${o.total} WHERE id = ${o.id}`, () => {
      const v = violations(2);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ check: 'paid_matches_payments', ref: o.code });
    });
    expect(violations(2)).toEqual([]);
  });

  it('flags a payment that was refunded without the order following it', async () => {
    const o = await newOrder(); await pay(o, o.total);
    tamper(`UPDATE payment_records SET status = 'refunded' WHERE order_id = ${o.id}`, `UPDATE payment_records SET status = 'completed' WHERE order_id = ${o.id}`, () => {
      expect(checks(2)).toEqual(['paid_matches_payments']);
    });
  });
});

describe('rule 6: payments never exceed what is owed', () => {
  it('flags an overpaid order', async () => {
    const o = await newOrder(); await pay(o, o.total);
    tamper(`INSERT INTO payment_records (store_id, direction, order_id, method, amount, recorded_by_staff_id) VALUES (${storeId}, 'incoming', ${o.id}, 'cash', 500, ${staffId});
            UPDATE orders SET amount_paid = ${o.total + 500} WHERE id = ${o.id}`,
    `DELETE FROM payment_records WHERE order_id = ${o.id} AND method = 'cash'; UPDATE orders SET amount_paid = ${o.total} WHERE id = ${o.id}`, () => {
      const v = violations(6);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ check: 'order_within_total', ref: o.code });
      expect(violations(2)).toEqual([]); // the counter and the payments agree; the problem is that they exceed the order
    });
    expect(violations(6)).toEqual([]);
  });

  it('flags a negative paid amount', async () => {
    const o = await newOrder();
    tamper(`UPDATE orders SET amount_paid = -100 WHERE id = ${o.id}`, `UPDATE orders SET amount_paid = 0 WHERE id = ${o.id}`, () => {
      expect(checks(6)).toEqual(['order_within_total']);
    });
  });
});

describe('rule 10: order references are unique and well formed', () => {
  it('flags a reference repeated in a different case', async () => {
    const a = await newOrder(); const b = await newOrder();
    tamper(`UPDATE orders SET product_code = lower('${a.code}') WHERE id = ${b.id}`, `UPDATE orders SET product_code = '${b.code}' WHERE id = ${b.id}`, () => {
      expect(checks(10)).toContain('ref_unique');
      expect(checks(10)).toContain('ref_format'); // lower case is malformed too
    });
    expect(violations(10)).toEqual([]);
  });

  it('flags an exact duplicate when the unique index has been dropped', async () => {
    const a = await newOrder(); const b = await newOrder();
    const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_orders_product_code'`).get().sql;
    db.exec('DROP INDEX idx_orders_product_code');
    try {
      db.prepare('UPDATE orders SET product_code = ? WHERE id = ?').run(a.code, b.id);
      expect(violations(10).map((v) => v.check)).toEqual(['ref_unique']);
    } finally {
      db.prepare('UPDATE orders SET product_code = ? WHERE id = ?').run(b.code, b.id);
      db.exec(idx);
    }
  });

  it('flags a missing or malformed reference', async () => {
    const o = await newOrder();
    tamper(`UPDATE orders SET product_code = NULL WHERE id = ${o.id}`, `UPDATE orders SET product_code = '${o.code}' WHERE id = ${o.id}`, () => {
      expect(checks(10)).toEqual(['ref_missing']);
    });
    tamper(`UPDATE orders SET product_code = 'ORDER-1' WHERE id = ${o.id}`, `UPDATE orders SET product_code = '${o.code}' WHERE id = ${o.id}`, () => {
      expect(checks(10)).toEqual(['ref_format']);
    });
  });
});

describe('rule 11: every dispatch has a fee line', () => {
  it('flags an organization parcel dispatched with no package fee, but not a rider with a zero fee', async () => {
    const org = (await auth(request(app).post('/api/couriers')).send({ name: `Org11 ${Date.now()}`, kind: 'organization', collects_payment: true })).body.data;
    const rider = (await auth(request(app).post('/api/couriers')).send({ name: `Rider11 ${Date.now()}`, kind: 'rider', courier_type: 'boda' })).body.data;
    const viaOrg = await newOrder({ courierId: org.id, fee: 15_000 });
    const viaRider = await newOrder({ courierId: rider.id });
    expect(violations(11)).toEqual([]); // a rider's missing zero fee is by design

    const fee = db.prepare('SELECT * FROM package_fees WHERE order_id = ?').get(viaOrg.id);
    db.prepare('DELETE FROM package_fees WHERE id = ?').run(fee.id);
    try {
      const v = violations(11);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ check: 'dispatch_has_fee', ref: viaOrg.code });
    } finally {
      db.prepare('INSERT INTO package_fees (id, store_id, order_id, courier_id, amount, zero_reason, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(fee.id, fee.store_id, fee.order_id, fee.courier_id, fee.amount, fee.zero_reason, fee.recorded_by, fee.recorded_at);
    }
    expect(violations(11)).toEqual([]);
    expect(viaRider.id).toBeTruthy();
  });

  it('flags a fee on a parcel that was never dispatched', async () => {
    const org = (await auth(request(app).post('/api/couriers')).send({ name: `Org11b ${Date.now()}`, kind: 'organization', collects_payment: true })).body.data;
    const o = await newOrder({ courierId: org.id, fee: 9_000 });
    tamper(`UPDATE orders SET status = 'awaiting_dispatch' WHERE id = ${o.id}`, `UPDATE orders SET status = 'dispatched_unpaid' WHERE id = ${o.id}`, () => {
      expect(checks(11)).toEqual(['fee_without_dispatch']);
    });
  });
});

describe('rule 12: fees and costs are never combined', () => {
  it('flags a payout whose totals do not come from its lines', () => {
    const courierId = db.prepare(`SELECT id FROM couriers WHERE kind = 'rider' LIMIT 1`).get().id;
    const id = db.prepare(`INSERT INTO rider_payouts (store_id, courier_id, fees_total, costs_total, total, method, paid_by) VALUES (?, ?, 100, 0, 100, 'cash', ?)`)
      .run(storeId, courierId, staffId).lastInsertRowid;
    try {
      expect(checks(12)).toEqual(['payout_totals_match']);
    } finally {
      db.prepare('DELETE FROM rider_payouts WHERE id = ?').run(id);
    }
    expect(violations(12)).toEqual([]);
  });
});

describe('rules 8 and 9: commission and locked payroll', () => {
  it('flags commission paid on money that is no longer secure', () => {
    const co = db.prepare('SELECT order_id FROM commissioned_orders LIMIT 1').get();
    tamper(`UPDATE payment_records SET status = 'refunded' WHERE order_id = ${co.order_id}`, `UPDATE payment_records SET status = 'completed' WHERE order_id = ${co.order_id}`, () => {
      expect(checks(8)).toContain('commission_secure');
    });
    expect(violations(8)).toEqual([]);
  });

  it('flags a locked run whose figures were altered behind the triggers', () => {
    const run = db.prepare(`SELECT id FROM payroll_runs WHERE status <> 'draft' LIMIT 1`).get();
    const item = db.prepare('SELECT id FROM payroll_items WHERE run_id = ? LIMIT 1').get(run.id);
    withoutTrigger('payroll_items_upd_locked', () => {
      db.prepare('UPDATE payroll_items SET days_worked = days_worked + 1 WHERE id = ?').run(item.id);
      try {
        expect(checks(9)).toContain('locked_run_unchanged');
      } finally {
        db.prepare('UPDATE payroll_items SET days_worked = days_worked - 1 WHERE id = ?').run(item.id);
      }
    });
    expect(violations(9)).toEqual([]);
  });

  it('flags a missing protection trigger, against the rule it protects', () => {
    withoutTrigger('payroll_runs_paid_is_final', () => {
      expect(violations(9)).toEqual([{ rule: 9, check: 'guard_present', message: 'Protection trigger payroll_runs_paid_is_final on payroll_runs is missing.' }]);
    });
    withoutTrigger('custody_no_delete', () => {
      expect(violations(7).map((v) => v.check)).toEqual(['guard_present']);
    });
    expect(runIntegrityChecks().ok).toBe(true);
  });
});

describe('supporting check: order lines add up', () => {
  it('flags an order whose subtotal no longer matches its lines', async () => {
    const o = await newOrder();
    const before = db.prepare('SELECT subtotal FROM orders WHERE id = ?').get(o.id).subtotal;
    tamper(`UPDATE orders SET subtotal = ${before + 1} WHERE id = ${o.id}`, `UPDATE orders SET subtotal = ${before} WHERE id = ${o.id}`, () => {
      expect(checks(null)).toEqual(['order_lines_match_subtotal']);
    });
  });
});

describe('the nightly job', () => {
  beforeEach(() => db.exec('DELETE FROM integrity_runs'));

  it('stores each run, and skips one that ran recently unless forced', () => {
    const first = runNightlyIntegrity();
    expect(first.ran).toBe(true);
    expect(db.prepare('SELECT ok, violation_count, source FROM integrity_runs').get()).toEqual({ ok: 1, violation_count: 0, source: 'nightly' });
    expect(runNightlyIntegrity()).toEqual({ ran: false, skipped: 'ran recently' });
    expect(runNightlyIntegrity({ force: true, source: 'cli' }).ran).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM integrity_runs').get().n).toBe(2);
  });

  it('a failure is stored, alerts the admins, and the alert clears once a later run is clean', async () => {
    const o = await newOrder(); await pay(o, o.total);
    db.exec(`UPDATE orders SET amount_paid = 1 WHERE id = ${o.id}`);
    try {
      const failed = runNightlyIntegrity({ force: true });
      expect(failed.report.ok).toBe(false);
      const row = db.prepare('SELECT ok, violation_count, violations FROM integrity_runs ORDER BY id DESC').get();
      expect(row.ok).toBe(0);
      expect(JSON.parse(row.violations)[0]).toMatchObject({ rule: 2, ref: o.code });
      const notice = db.prepare(`SELECT title, dedupe_key FROM notifications WHERE type = 'integrity_failed'`).all();
      expect(notice.length).toBeGreaterThan(0);
      expect(notice.every((n) => n.dedupe_key === 'integrity_failed')).toBe(true);
    } finally {
      db.exec(`UPDATE orders SET amount_paid = ${o.total} WHERE id = ${o.id}`);
    }
    expect(runNightlyIntegrity({ force: true }).report.ok).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE type = 'integrity_failed' AND dedupe_key IS NOT NULL`).get().n).toBe(0);
  });

  it('is scheduled for 02:00 shop time, never in the past', () => {
    const HOUR = 3_600_000;
    // Nairobi is UTC+3: 20:00 UTC is 23:00 local, so 02:00 is three hours away.
    expect(msUntilNextRun(new Date('2026-10-30T20:00:00Z'), 2, 180)).toBe(3 * HOUR);
    expect(msUntilNextRun(new Date('2026-10-30T22:00:00Z'), 2, 180)).toBe(1 * HOUR); // 01:00 local
    expect(msUntilNextRun(new Date('2026-10-30T23:00:00Z'), 2, 180)).toBe(24 * HOUR); // exactly 02:00: next one is tomorrow's
    expect(msUntilNextRun(new Date('2026-10-30T09:00:00Z'), 2, 180)).toBe(14 * HOUR);
  });
});

describe('npm run integrity', () => {
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'integrity-check.js'), ...args], { env: process.env, encoding: 'utf8' });

  it('exits 0 when everything holds, and prints the full report as JSON on request', () => {
    const res = cli();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Integrity check passed/);
    const json = cli('--json');
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, violations: [] });
  });

  it('exits 1 and lists the problems when a rule is broken, even if it already ran today', async () => {
    const o = await newOrder(); await pay(o, o.total);
    db.exec(`UPDATE orders SET amount_paid = 1 WHERE id = ${o.id}`);
    try {
      const res = cli();
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/FAILED: 1 problem/);
      expect(res.stderr).toMatch(new RegExp(`\\[rule 2\\] paid_matches_payments: Order ${o.code}`));
    } finally {
      db.exec(`UPDATE orders SET amount_paid = ${o.total} WHERE id = ${o.id}`);
    }
  });
});
