const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const { localDate } = require('../src/utils/storeTime');
const runs = require('../src/services/payrollRuns.service');
const { securedOrders } = require('../src/services/commission.service');

let adminToken;
let adminId;
let repId;
let repToken;
let product;
const today = localDate();
const auth = (t = adminToken) => ({ Authorization: `Bearer ${t}` });

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  adminId = db.prepare(`SELECT id FROM users WHERE email = 'admin@urbantrends.com'`).get().id;

  const createRep = await request(app).post('/api/staff').set(auth())
    .send({ name: 'Runs Rep', email: 'runsrep@urbantrends.com', phone: '0722100777', password: 'Marble-Thistle-4678', role: 'cashier' });
  repId = createRep.body.data.id;
  repToken = (await request(app).post('/api/auth/login').send({ email: 'runsrep@urbantrends.com', password: 'Marble-Thistle-4678' })).body.token;
  await request(app).post('/api/attendance/clock-in').set(auth(repToken));

  product = (await request(app).get('/api/products?pageSize=1').set(auth())).body.data[0];
});
afterAll(() => cleanupTestDb());

async function dispatchedOrder(phone, quantity = 1) {
  const res = await request(app).post('/api/orders').set(auth())
    .send({ name: 'Runs Order', phone, payment_type: 'prepaid', assigned_staff_id: repId, items: [{ product_id: product.id, quantity }] });
  const orderId = res.body.data.id;
  await request(app).post(`/api/orders/${orderId}/dispatch`).set(auth());
  return { orderId, total: res.body.data.total };
}
const pay = (orderId, amount, method = 'mobile_money') =>
  request(app).post(`/api/orders/${orderId}/payments`).set(auth()).send({ method, amount, reference: `T${orderId}${method}` });
const ref = (orderId) => `#${orderId}`;
const commissionLines = (run) => run.items.flatMap((i) => i.lines).filter((l) => l.kind === 'commission_order');

describe('commission is earned only on secure money (Rule 8)', () => {
  it('counts a fully paid mobile-money order', async () => {
    const { orderId, total } = await dispatchedOrder('0733300001', 2);
    await pay(orderId, total);
    const secured = securedOrders({ storeId: 1, staffId: repId }).find((o) => o.orderId === orderId);
    expect(secured).toBeTruthy();
    expect(secured.units).toBe(2);
    expect(secured.total).toBe(total);
  });

  it('does not count a part-paid order', async () => {
    const { orderId, total } = await dispatchedOrder('0733300002');
    await pay(orderId, Math.floor(total / 2));
    expect(securedOrders({ storeId: 1, staffId: repId }).some((o) => o.orderId === orderId)).toBe(false);
  });

  it('does not count shop cash until it is deposited', async () => {
    const { orderId, total } = await dispatchedOrder('0733300003');
    const cash = await request(app).post(`/api/orders/${orderId}/shop-cash`).set(auth()).send({ amount: total, reason: 'Customer walked in' });
    expect(cash.status).toBeLessThan(300);
    expect(securedOrders({ storeId: 1, staffId: repId }).some((o) => o.orderId === orderId)).toBe(false);

    const custodyId = db.prepare('SELECT id FROM custody_records WHERE order_id = ?').get(orderId).id;
    const dep = await request(app).post(`/api/custody/${custodyId}/deposit`).set(auth());
    expect(dep.status).toBe(200);
    expect(securedOrders({ storeId: 1, staffId: repId }).some((o) => o.orderId === orderId)).toBe(true);
  });
});

describe('locked payroll runs (Rule 9)', () => {
  let runId;
  let draft;

  it('needs a real period', async () => {
    const res = await request(app).post('/api/payroll/runs').set(auth()).send({ from: today, to: '2000-01-01' });
    expect(res.status).toBe(422);
    expect(res.body.code || res.body.error?.code).toBe('PAYROLL_BAD_PERIOD');
  });

  it('generates a draft snapshot with itemised lines', async () => {
    const res = await request(app).post('/api/payroll/runs').set(auth()).send({ from: today, to: today });
    expect(res.status).toBe(201);
    draft = res.body.data;
    runId = draft.id;
    expect(draft.status).toBe('draft');
    expect(draft.checksum).toBeNull();
    const rep = draft.items.find((i) => i.staffId === repId);
    expect(rep.daysWorked).toBe(1);
    expect(rep.retainer).toBe(30000);
    expect(rep.commission).toBe(rep.unitsSold * rep.rate);
    expect(rep.gross).toBe(rep.retainer + rep.commission);
    expect(rep.net).toBe(rep.gross - rep.deductions);
    expect(commissionLines(draft).length).toBeGreaterThan(0);
    expect(draft.items.find((i) => i.staffId === repId).lines.filter((l) => l.kind === 'retainer_day')).toHaveLength(1);
  });

  it('regenerating the same period replaces the draft instead of adding another', async () => {
    const res = await request(app).post('/api/payroll/runs').set(auth()).send({ from: today, to: today });
    expect(res.body.data.id).toBe(runId);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM payroll_runs WHERE status = 'draft'`).get().n).toBe(1);
  });

  it('approving needs an admin', async () => {
    const res = await request(app).post(`/api/payroll/runs/${runId}/approve`).set(auth(repToken));
    expect(res.status).toBe(403);
  });

  it('refuses a stale draft: something changed after it was generated', async () => {
    const { orderId, total } = await dispatchedOrder('0733300010');
    await pay(orderId, total); // a new order becomes secure after the draft was reviewed
    const res = await request(app).post(`/api/payroll/runs/${runId}/approve`).set(auth());
    expect(res.status).toBe(409);
    expect(res.body.code || res.body.error?.code).toBe('RUN_STALE');
    expect(db.prepare('SELECT status FROM payroll_runs WHERE id = ?').get(runId).status).toBe('draft');
    expect(db.prepare('SELECT COUNT(*) AS n FROM commissioned_orders').get().n).toBe(0); // the failed approval left nothing behind
    const fresh = await request(app).post('/api/payroll/runs').set(auth()).send({ from: today, to: today });
    draft = fresh.body.data;
  });

  it('approving locks the run, fingerprints it and records every commissioned order', async () => {
    const res = await request(app).post(`/api/payroll/runs/${runId}/approve`).set(auth());
    expect(res.status).toBe(200);
    const run = res.body.data;
    expect(run.status).toBe('approved');
    expect(run.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(run.approvedBy).toBe(adminId);

    const commissioned = db.prepare('SELECT order_id FROM commissioned_orders WHERE run_id = ?').all(runId);
    expect(commissioned.length).toBe(commissionLines(run).length);
    expect(commissioned.length).toBeGreaterThan(0);
    expect(run.items).toEqual(draft.items);
  });

  it('the fingerprint verifies, and the run is the same whatever happens afterwards', async () => {
    const before = (await request(app).get(`/api/payroll/runs/${runId}`).set(auth())).body.data;
    // settings change, a new order is paid: a locked run must not move
    db.prepare(`UPDATE settings SET value = '99999' WHERE key = 'daily_retainer_kes'`).run();
    const { orderId, total } = await dispatchedOrder('0733300011');
    await pay(orderId, total);
    const after = (await request(app).get(`/api/payroll/runs/${runId}`).set(auth())).body.data;
    expect(after).toEqual(before);
    const verify = (await request(app).get(`/api/payroll/runs/${runId}/verify`).set(auth())).body.data;
    expect(verify).toMatchObject({ locked: true, intact: true, checksum: before.checksum });
    db.prepare(`UPDATE settings SET value = '300' WHERE key = 'daily_retainer_kes'`).run();
  });

  it('commission is paid once: commissioned orders drop out of any later calculation', () => {
    const commissionedIds = db.prepare('SELECT order_id FROM commissioned_orders').all().map((r) => r.order_id);
    const live = securedOrders({ storeId: 1, staffId: repId }).map((o) => o.orderId);
    for (const id of commissionedIds) expect(live).not.toContain(id);
    // ...and the database itself refuses to commission one twice
    const o = db.prepare('SELECT * FROM commissioned_orders LIMIT 1').get();
    expect(() => db.prepare('INSERT INTO commissioned_orders (order_id, run_id, staff_id, units, total, secured_at) VALUES (?, ?, ?, 1, 1, ?)')
      .run(o.order_id, runId, o.staff_id, o.secured_at)).toThrow();
  });

  it('a locked period cannot be regenerated or overlapped, and a second approval is refused', async () => {
    const regen = await request(app).post('/api/payroll/runs').set(auth()).send({ from: today, to: today });
    expect(regen.status).toBe(409);
    expect(regen.body.code || regen.body.error?.code).toBe('PERIOD_LOCKED');
    const again = await request(app).post(`/api/payroll/runs/${runId}/approve`).set(auth());
    expect(again.status).toBe(409);
    expect(again.body.code || again.body.error?.code).toBe('RUN_NOT_DRAFT');
  });

  it('the database refuses to change a locked run, however it is attempted', () => {
    const item = db.prepare('SELECT id FROM payroll_items WHERE run_id = ?').get(runId);
    const line = db.prepare('SELECT id FROM payroll_item_lines WHERE item_id = ?').get(item.id);
    expect(() => db.prepare('UPDATE payroll_items SET commission = 0, units_sold = 0, gross = retainer, net = gross - deductions, payable = MAX(net,0) WHERE id = ?').run(item.id)).toThrow(/locked/);
    expect(() => db.prepare('DELETE FROM payroll_items WHERE id = ?').run(item.id)).toThrow(/locked/);
    expect(() => db.prepare('UPDATE payroll_item_lines SET amount = 1 WHERE id = ?').run(line.id)).toThrow(/locked/);
    expect(() => db.prepare('DELETE FROM payroll_item_lines WHERE id = ?').run(line.id)).toThrow(/locked/);
    expect(() => db.prepare(`INSERT INTO payroll_items (run_id, staff_id, staff_name, days_worked, retainer, units_sold, achieved_sales, target, achievement_bp, tier, rate,
      commission, late, absence, missing_hours, advances, loss_deductions, gross, deductions, net, payable, shortfall)
      VALUES (?, ?, 'x', 0,0,0,0,0,0,'<70%',0,0,0,0,0,0,0,0,0,0,0,0)`).run(runId, adminId)).toThrow(/locked/);
    expect(() => db.prepare('UPDATE payroll_runs SET checksum = ? WHERE id = ?').run('f'.repeat(64), runId)).toThrow();
    expect(() => db.prepare('UPDATE payroll_runs SET period_end = ? WHERE id = ?').run('2999-01-01', runId)).toThrow();
    expect(() => db.prepare('DELETE FROM payroll_runs WHERE id = ?').run(runId)).toThrow(/never be deleted/);
    expect(() => db.prepare('DELETE FROM commissioned_orders WHERE run_id = ?').run(runId)).toThrow(/never change/);
  });

  it('verification catches a run altered behind the back of the triggers', () => {
    // simulate someone dropping the guard to tamper, then restoring it
    const item = db.prepare('SELECT id FROM payroll_items WHERE run_id = ? LIMIT 1').get(runId);
    const trig = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'payroll_items_upd_locked'`).get().sql;
    db.exec('DROP TRIGGER payroll_items_upd_locked');
    db.prepare('UPDATE payroll_items SET days_worked = days_worked + 1 WHERE id = ?').run(item.id);
    db.exec(trig);
    expect(runs.verifyRun({ runId, storeId: 1 }).intact).toBe(false);
    db.exec('DROP TRIGGER payroll_items_upd_locked');
    db.prepare('UPDATE payroll_items SET days_worked = days_worked - 1 WHERE id = ?').run(item.id);
    db.exec(trig);
    expect(runs.verifyRun({ runId, storeId: 1 }).intact).toBe(true);
  });

  it('pays an approved run once, and a paid run is final', async () => {
    const noRef = await request(app).post(`/api/payroll/runs/${runId}/pay`).set(auth()).send({ method: 'mpesa' });
    expect(noRef.status).toBe(422);
    const badMethod = await request(app).post(`/api/payroll/runs/${runId}/pay`).set(auth()).send({ method: 'barter' });
    expect(badMethod.status).toBe(422);

    const paid = await request(app).post(`/api/payroll/runs/${runId}/pay`).set(auth()).send({ method: 'mpesa', payment_ref: 'QWE123' });
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({ status: 'paid', paymentMethod: 'mpesa', paymentRef: 'QWE123' });
    expect(paid.body.data.checksum).toMatch(/^[0-9a-f]{64}$/);

    const twice = await request(app).post(`/api/payroll/runs/${runId}/pay`).set(auth()).send({ method: 'cash' });
    expect(twice.status).toBe(409);
    expect(() => db.prepare(`UPDATE payroll_runs SET payment_ref = 'X' WHERE id = ?`).run(runId)).toThrow(/paid payroll run never changes/);
    expect(runs.verifyRun({ runId, storeId: 1 })).toMatchObject({ status: 'paid', intact: true });
  });

  it('lists runs', async () => {
    const res = await request(app).get('/api/payroll/runs').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.map((r) => r.id)).toContain(runId);
  });

  it('cannot pay a draft', async () => {
    const res = await request(app).post('/api/payroll/runs').set(auth()).send({ from: '2020-01-01', to: '2020-01-07' });
    expect(res.status).toBe(201);
    const pay2 = await request(app).post(`/api/payroll/runs/${res.body.data.id}/pay`).set(auth()).send({ method: 'cash' });
    expect(pay2.status).toBe(409);
    const empty = await request(app).post(`/api/payroll/runs/${res.body.data.id}/approve`).set(auth());
    expect(empty.body.code || empty.body.error?.code).toBe('RUN_EMPTY');
  });
});
