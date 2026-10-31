const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const { localDate } = require('../src/utils/storeTime');
const payCycle = require('../src/utils/payCycle');
const runs = require('../src/services/payrollRuns.service');
const payroll = require('../src/services/payroll.service');
const shift = require('../src/services/shift.service');

let adminToken;
let n = 0;
const today = localDate();
const auth = (t = adminToken) => ({ Authorization: `Bearer ${t}` });
const codeOf = (res) => res.body.code || res.body.error?.code;

beforeAll(async () => { adminToken = await loginAsAdmin(); });
afterAll(() => cleanupTestDb());

async function makeRep(name) {
  n += 1;
  const email = `p3rep${n}@urbantrends.com`;
  const created = await request(app).post('/api/staff').set(auth())
    .send({ name, email, phone: `07221009${String(n).padStart(2, '0')}`, password: 'Marble-Thistle-4678', role: 'cashier' });
  expect(created.status).toBe(201);
  const token = (await request(app).post('/api/auth/login').send({ email, password: 'Marble-Thistle-4678' })).body.token;
  await request(app).post('/api/attendance/clock-in').set(auth(token));
  return { id: created.body.data.id, token, name };
}

// A dispatched, fully paid order assigned to the rep: 2 units at 5000 each = 10000.
async function securedOrder(rep, { unitPrice = 5000, quantity = 2 } = {}) {
  n += 1;
  const pid = db.prepare(`INSERT INTO products (sku, name, cost_price, sell_price, is_active) VALUES (?, 'P3 Product', 100, ?, 1)`).run(`P3-${n}-${Date.now()}`, unitPrice).lastInsertRowid;
  db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, 1, 500)').run(pid);
  const created = await request(app).post('/api/orders').set(auth())
    .send({ name: 'P3 Customer', phone: `07330009${String(n).padStart(2, '0')}`, city: 'Nairobi', payment_type: 'prepaid', assigned_staff_id: rep.id, items: [{ product_id: pid, quantity }] });
  expect(created.status).toBe(201);
  const id = created.body.data.id;
  expect((await request(app).post(`/api/orders/${id}/dispatch`).set(auth())).status).toBe(200);
  const total = created.body.data.total;
  expect((await request(app).post(`/api/orders/${id}/payments`).set(auth()).send({ method: 'mobile_money', amount: total, reference: `P3${id}${Date.now()}` })).status).toBe(201);
  return { id, total, units: quantity };
}
const setTerms = (staffId, body) => request(app).put(`/api/payroll/pay-terms/${staffId}`).set(auth()).send(body);
const itemFor = (run, staffId) => run.items.find((i) => i.staffId === staffId);

describe('pay cycle (item 7)', () => {
  it('computes the pay date as the 3rd of the following month', () => {
    expect(payCycle.payDateFor('2026-10-31')).toBe('2026-11-03');
    expect(payCycle.payDateFor('2026-12-15')).toBe('2027-01-03');
    expect(payCycle.payDateFor('2026-10-31', 10)).toBe('2026-11-10');
    expect(payCycle.payDateFor('2026-10-31', 31)).toBe('2026-11-03'); // unusable day falls back to the 3rd
    expect(payCycle.monthBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('refuses a period that crosses a month, for runs and for the live summary', async () => {
    const run = await request(app).post('/api/payroll/runs').set(auth()).send({ from: '2026-01-15', to: '2026-02-10' });
    expect(run.status).toBe(422);
    expect(codeOf(run)).toBe('PAYROLL_CROSSES_MONTH');
    const rep = await makeRep('Cycle Rep');
    const sum = await request(app).get(`/api/payroll/summary?staff_id=${rep.id}&from=2026-01-15&to=2026-02-10`).set(auth());
    expect(sum.status).toBe(422);
    expect(codeOf(sum)).toBe('PAYROLL_CROSSES_MONTH');
  });

  it('still reports profit over a range that spans months (labor cost is costed month by month)', async () => {
    await makeRep('Report Rep');
    const res = await request(app).get('/api/reports/profit-summary?from=2026-01-20&to=2026-03-05').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('laborCost');
  });

  it('generates a whole month from { month } and stamps the fixed pay date', async () => {
    const month = payCycle.monthOf(today);
    const res = await request(app).post('/api/payroll/runs').set(auth()).send({ month });
    expect(res.status).toBe(201);
    const { from, to } = payCycle.monthBounds(month);
    expect(res.body.data).toMatchObject({ periodStart: from, periodEnd: to, payDate: payCycle.payDateFor(to) });
    expect((await request(app).post('/api/payroll/runs').set(auth()).send({ month: '2026-13' })).status).toBe(422);
  });

  it('reports where the cycle stands', async () => {
    const res = await request(app).get('/api/payroll/cycle').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.payDay).toBe(3);
    expect(res.body.data.current.month).toBe(payCycle.monthOf(today));
    expect(res.body.data.previous.payDate).toBe(payCycle.payDateFor(res.body.data.previous.to));
  });
});

describe('pay types per employee (item 8)', () => {
  it('defaults to fixed on the store tiers, so nothing moves for existing staff', async () => {
    const rep = await makeRep('Default Rep');
    const terms = (await request(app).get('/api/payroll/pay-terms').set(auth())).body.data.find((t) => t.staffId === rep.id);
    expect(terms).toMatchObject({ type: 'fixed', fixedCents: null, percentBp: 0 });
  });

  it('is admin only and validated', async () => {
    const rep = await makeRep('Terms Rep');
    expect((await request(app).get('/api/payroll/pay-terms').set(auth(rep.token))).status).toBe(403);
    expect((await setTerms(rep.id, { type: 'barter' })).status).toBe(422);
    expect(codeOf(await setTerms(rep.id, { type: 'percentage' }))).toBe('PERCENT_REQUIRED');
    expect((await setTerms(rep.id, { type: 'combined', percent_bp: 20000 })).status).toBe(422);
    expect((await setTerms(rep.id, { type: 'fixed', fixed_cents: -5 })).status).toBe(422);
    expect((await setTerms(99999, { type: 'fixed' })).status).toBe(404);
  });

  it('fixed with an own amount pays that amount per unit instead of the tier', async () => {
    const rep = await makeRep('Fixed Rep');
    expect((await setTerms(rep.id, { type: 'fixed', fixed_cents: 7500 })).status).toBe(200);
    const o = await securedOrder(rep, { quantity: 3 });
    const items = runs.previewPayroll({ storeId: 1, from: today, to: today });
    const item = itemFor({ items }, rep.id);
    expect(item.commissionType).toBe('fixed');
    expect(item.rate).toBe(7500);
    expect(item.commission).toBe(o.units * 7500);
  });

  it('percentage pays a share of the order value, with no per-unit amount', async () => {
    const rep = await makeRep('Percent Rep');
    expect((await setTerms(rep.id, { type: 'percentage', percent_bp: 250, fixed_cents: 9999 })).body.data).toMatchObject({ fixedCents: null, percentBp: 250 });
    const o = await securedOrder(rep);
    const item = itemFor({ items: runs.previewPayroll({ storeId: 1, from: today, to: today }) }, rep.id);
    expect(item).toMatchObject({ commissionType: 'percentage', percentBp: 250, rate: 0 });
    expect(item.commission).toBe(Math.floor((o.total * 250) / 10000));
  });

  it('combined pays the per-unit amount and the share together', async () => {
    const rep = await makeRep('Combined Rep');
    await setTerms(rep.id, { type: 'combined', fixed_cents: 1000, percent_bp: 100 });
    const o = await securedOrder(rep, { quantity: 2 });
    const item = itemFor({ items: runs.previewPayroll({ storeId: 1, from: today, to: today }) }, rep.id);
    expect(item.commission).toBe(o.units * 1000 + Math.floor((o.total * 100) / 10000));
  });
});

// One locked run for today is shared by everything that needs one (a day can only be locked once): a percentage-paid
// rep, a fixed-paid rep whose sale is later refunded, a rep whose sale is later deleted, and a rep whose sale stays
// good. Then the run is paid with sign-off.
describe('locked run: pay types, sign-off and commission reversal (items 7 and 8)', () => {
  let runId;
  let approved;
  let pctRep; let revRep; let sweepRep; let goodRep;
  let pctOrder; let revOrder; let sweepOrder; let goodOrder;
  const adjustmentsFor = (orderId) => db.prepare('SELECT * FROM payroll_adjustments WHERE reverses_order_id = ?').all(orderId);
  const reversal = require('../src/services/commissionReversal.service');

  beforeAll(async () => {
    pctRep = await makeRep('Locked Percent Rep');
    revRep = await makeRep('Reversal Rep');
    sweepRep = await makeRep('Sweep Rep');
    goodRep = await makeRep('Good Rep');
    await setTerms(pctRep.id, { type: 'percentage', percent_bp: 300 });
    await setTerms(revRep.id, { type: 'fixed', fixed_cents: 4000 });
    pctOrder = await securedOrder(pctRep);
    revOrder = await securedOrder(revRep);
    sweepOrder = await securedOrder(sweepRep);
    goodOrder = await securedOrder(goodRep);
    const draft = await request(app).post('/api/payroll/runs').set(auth()).send({ from: today, to: today });
    expect(draft.status).toBe(201);
    runId = draft.body.data.id;
    approved = await request(app).post(`/api/payroll/runs/${runId}/approve`).set(auth());
    expect(approved.status).toBe(200);
  });

  it('a percentage-paid person saves, locks and verifies, and the per-order amount is recorded', () => {
    const item = itemFor(approved.body.data, pctRep.id);
    expect(item).toMatchObject({ commissionType: 'percentage', percentBp: 300, rate: 0 });
    expect(item.commission).toBe(Math.floor((pctOrder.total * 300) / 10000));
    expect(runs.verifyRun({ runId, storeId: 1 })).toMatchObject({ locked: true, intact: true });
    expect(db.prepare('SELECT commission FROM commissioned_orders WHERE order_id = ?').get(pctOrder.id).commission).toBe(item.commission);
    expect(approved.body.data.payDate).toBe(payCycle.payDateFor(today));
  });

  it('takes the commission back, once, when a commissioned order is refunded', async () => {
    const paidOut = db.prepare('SELECT commission FROM commissioned_orders WHERE order_id = ?').get(revOrder.id).commission;
    expect(paidOut).toBe(8000);

    const paymentId = db.prepare('SELECT id FROM payment_records WHERE order_id = ?').get(revOrder.id).id;
    expect((await request(app).post(`/api/payments/${paymentId}/refund`).set(auth())).status).toBe(200);

    const adj = adjustmentsFor(revOrder.id);
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ staff_id: revRep.id, type: 'loss_deduction', amount: paidOut });
    expect(adj[0].notes).toMatch(/Commission reversed/);
    // the locked run never moved, and doing it again is a no-op
    expect(runs.verifyRun({ runId, storeId: 1 }).intact).toBe(true);
    expect(reversal.sweepReversals({ storeId: 1 }).map((a) => a.reverses_order_id)).not.toContain(revOrder.id);
    expect(reversal.reverseForOrder({ orderId: revOrder.id, reason: 'again' })).toBeNull();
    expect(adjustmentsFor(revOrder.id)).toHaveLength(1);
  });

  it('dates the reversal after the locked period, so a later run actually picks it up', () => {
    const adj = adjustmentsFor(revOrder.id)[0];
    const adjDate = db.prepare(`SELECT date(?, '+3 hours') AS d`).get(adj.created_at).d;
    expect(adjDate > today).toBe(true);
    // a calculation over that day sees it as a deduction (getSummary only spans one month, so skip if it rolled over)
    if (payCycle.sameMonth(adjDate, adjDate)) {
      const summary = payroll.getSummary({ staffId: revRep.id, storeId: 1, periodStart: adjDate, periodEnd: adjDate });
      expect(summary.commissionReversalsTotal).toBe(8000);
      expect(summary.adjustmentsTotal).toBeGreaterThanOrEqual(8000);
    }
  });

  it('the sweep catches a sale that fell through by a route the hooks never see', () => {
    db.prepare(`UPDATE orders SET deleted_at = datetime('now') WHERE id = ?`).run(sweepOrder.id);
    const swept = reversal.sweepReversals({ storeId: 1 });
    expect(swept.map((a) => a.reverses_order_id)).toContain(sweepOrder.id);
    expect(adjustmentsFor(sweepOrder.id)[0]).toMatchObject({ staff_id: sweepRep.id });
  });

  it('leaves a sale that stands completely alone', () => {
    expect(adjustmentsFor(goodOrder.id)).toHaveLength(0);
  });

  it('pays only with the payer\'s own typed name and the run checksum, and records both', async () => {
    const pay = (body) => request(app).post(`/api/payroll/runs/${runId}/pay`).set(auth()).send({ method: 'cash', ...body });
    const checksum = approved.body.data.checksum;

    expect(codeOf(await pay({ checksum }))).toBe('SIGNATURE_REQUIRED');
    expect(codeOf(await pay({ signed_name: 'Somebody Else', checksum }))).toBe('SIGNATURE_MISMATCH');
    expect(codeOf(await pay({ signed_name: 'Store Admin' }))).toBe('PAYOUT_CHECKSUM_MISMATCH');
    expect(codeOf(await pay({ signed_name: 'Store Admin', checksum: 'f'.repeat(64) }))).toBe('PAYOUT_CHECKSUM_MISMATCH');
    expect(db.prepare('SELECT status FROM payroll_runs WHERE id = ?').get(runId).status).toBe('approved');

    const ok = await pay({ signed_name: '  store   ADMIN ', checksum });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'paid', signedOffName: 'store ADMIN', signedOffByName: 'Store Admin' });
    expect(ok.body.data.signedOffAt).toBeTruthy();
    expect(runs.verifyRun({ runId, storeId: 1 })).toMatchObject({ status: 'paid', intact: true });
  });
});

describe('employee signatures (item 8)', () => {
  it('requires the requester\'s own name to request an advance or goods', async () => {
    const rep = await makeRep('Sig Rep');
    const body = { type: 'salary_advance', amount: 50000, notes: 'Rent' };
    expect(codeOf(await request(app).post('/api/requisitions').set(auth(rep.token)).send(body))).toBe('SIGNATURE_REQUIRED');
    expect(codeOf(await request(app).post('/api/requisitions').set(auth(rep.token)).send({ ...body, signed_name: 'Someone Else' }))).toBe('SIGNATURE_MISMATCH');
    const ok = await request(app).post('/api/requisitions').set(auth(rep.token)).send({ ...body, signed_name: 'sig rep' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ request_signature_name: 'sig rep' });
    expect(ok.body.data.request_signature_at).toBeTruthy();
    const goods = await request(app).post('/api/requisitions').set(auth(rep.token)).send({ items: [{ product_id: 1, quantity_requested: 1 }] });
    expect(codeOf(goods)).toBe('SIGNATURE_REQUIRED');
  });

  it('lets only the requester acknowledge receipt, only once approved, only once', async () => {
    const rep = await makeRep('Receipt Rep');
    const other = await makeRep('Other Rep');
    const created = await request(app).post('/api/requisitions').set(auth(rep.token)).send({ type: 'salary_advance', amount: 20000, signed_name: 'Receipt Rep' });
    const id = created.body.data.id;
    const ack = (token, name) => request(app).patch(`/api/requisitions/${id}/acknowledge`).set(auth(token)).send({ signed_name: name });

    expect(codeOf(await ack(rep.token, 'Receipt Rep'))).toBe('ACK_NOT_APPROVED');
    expect((await request(app).patch(`/api/requisitions/${id}/approve`).set(auth()).send({})).status).toBe(200);

    const waiting = await request(app).get('/api/requisitions?awaiting_receipt=1&limit=100').set(auth());
    expect(waiting.body.data.some((r) => r.id === id)).toBe(true);

    expect(codeOf(await ack(other.token, 'Other Rep'))).toBe('ACK_NOT_REQUESTER');
    expect(codeOf(await ack(rep.token, 'Wrong Name'))).toBe('SIGNATURE_MISMATCH');
    const ok = await ack(rep.token, 'Receipt Rep');
    expect(ok.status).toBe(200);
    expect(ok.body.data.receipt_signature_at).toBeTruthy();
    expect(codeOf(await ack(rep.token, 'Receipt Rep'))).toBe('ACK_ALREADY_SIGNED');

    const after = await request(app).get('/api/requisitions?awaiting_receipt=1&limit=100').set(auth());
    expect(after.body.data.some((r) => r.id === id)).toBe(false);
  });
});

describe('late fee starts after 8:00 AM shop time (item 9)', () => {
  // clock_in_at is stored in UTC; the shop clock is UTC+3, so 08:00 at the shop is 05:00 UTC.
  const feeFor = (staffId, utcTime, date) => {
    db.prepare('DELETE FROM staff_attendance WHERE staff_id = ? AND work_date = ?').run(staffId, date);
    db.prepare('INSERT INTO staff_attendance (staff_id, store_id, work_date, clock_in_at) VALUES (?, 1, ?, ?)').run(staffId, date, `${date} ${utcTime}`);
    const settings = require('../src/services/settings.service').getAll();
    const r = payroll.computeAttendanceDeductions({ staffId, periodStart: date, periodEnd: date, settings });
    return r.lateTotal;
  };

  it('charges nothing at or before 08:00:00 and an hour from 08:00:01', async () => {
    const rep = await makeRep('Late Rep');
    const d = '2031-05-12';
    expect(feeFor(rep.id, '04:59:59', d)).toBe(0);  // 07:59:59
    expect(feeFor(rep.id, '05:00:00', d)).toBe(0);  // 08:00:00 exactly
    expect(feeFor(rep.id, '05:00:01', d)).toBe(5000); // 08:00:01 -> one hour late
    expect(feeFor(rep.id, '05:59:59', d)).toBe(5000);
    expect(feeFor(rep.id, '06:00:00', d)).toBe(5000); // 09:00:00 -> still one hour
    expect(feeFor(rep.id, '06:00:01', d)).toBe(10000); // 09:00:01 -> two hours
  });
});

describe('clock-out check coverage (item 9)', () => {
  const managerIds = () => db.prepare(`SELECT id FROM users WHERE role IN ('admin','manager') AND store_id = 1`).all().map((r) => r.id);
  const notesOf = (type, like) => db.prepare(`SELECT * FROM notifications WHERE type = ? AND title LIKE ?`).all(type, like);

  it('shows dispatched unpaid parcels with the Nairobi ones separated, open shop cash and unmatched payments', async () => {
    const rep = await makeRep('Checkout Rep');
    // a dispatched, unpaid Nairobi parcel
    n += 1;
    const pid = db.prepare(`INSERT INTO products (sku, name, cost_price, sell_price, is_active) VALUES (?, 'CO Product', 100, 3000, 1)`).run(`CO-${n}-${Date.now()}`).lastInsertRowid;
    db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, 1, 50)').run(pid);
    const created = await request(app).post('/api/orders').set(auth()).send({ name: 'CO Customer', phone: `07440009${String(n).padStart(2, '0')}`, city: 'Nairobi', payment_type: 'prepaid', assigned_staff_id: rep.id, items: [{ product_id: pid, quantity: 1 }] });
    await request(app).post(`/api/orders/${created.body.data.id}/dispatch`).set(auth());
    // open shop cash held by the rep
    const cashOrder = await securedOrderUnpaid(rep);
    const cash = await request(app).post(`/api/orders/${cashOrder}/shop-cash`).set(auth(rep.token)).send({ amount: 1000, reason: 'Walked in' });
    expect(cash.status).toBeLessThan(300);
    db.prepare(`INSERT INTO payment_notifications (store_id, source, method, amount, direction, status) VALUES (1, 'manual', 'mobile_money', 4200, 'incoming', 'unmatched')`).run();

    const h = shift.getHandover({ userId: rep.id, storeId: 1 });
    expect(h.unpaid_parcels.count).toBeGreaterThanOrEqual(1);
    expect(h.nairobi_unpaid.count).toBeGreaterThanOrEqual(1);
    expect(h.custody_open).toMatchObject({ count: 1, amount: 1000 });
    expect(h.unmatched_payments.count).toBeGreaterThanOrEqual(1);
    expect(h.has_open_items).toBe(true);
  });

  it('unmatched payments alone do not raise a manager alert (they belong to the shop, not one rep)', async () => {
    const rep = await makeRep('Quiet Rep');
    db.prepare(`INSERT INTO payment_notifications (store_id, source, method, amount, direction, status) VALUES (1, 'manual', 'mobile_money', 100, 'incoming', 'unmatched')`).run();
    const h = shift.getHandover({ userId: rep.id, storeId: 1 });
    expect(h.unmatched_payments.count).toBeGreaterThan(0);
    expect(h.has_open_items).toBe(false);
  });

  it('a manager note reaches the managers even when nothing is open', async () => {
    const rep = await makeRep('Noter Rep');
    const out = await request(app).post('/api/attendance/clock-out').set(auth(rep.token)).send({ handover_notes: 'Till is 200 short, will explain' });
    expect(out.status).toBe(200);
    expect(out.body.handover.has_open_items).toBe(false);
    const notes = notesOf('shift_note', '%Noter Rep%');
    expect(notes.map((x) => x.user_id).sort()).toEqual(managerIds().sort());
    expect(notes[0].body).toContain('Till is 200 short');
    // and a clean clock-out with no note raises nothing
    const rep2 = await makeRep('Silent Rep');
    await request(app).post('/api/attendance/clock-out').set(auth(rep2.token)).send({});
    expect(notesOf('shift_note', '%Silent Rep%')).toHaveLength(0);
    expect(notesOf('shift_handover', '%Silent Rep%')).toHaveLength(0);
  });
});

async function securedOrderUnpaid(rep) {
  n += 1;
  const pid = db.prepare(`INSERT INTO products (sku, name, cost_price, sell_price, is_active) VALUES (?, 'CS Product', 100, 3000, 1)`).run(`CS-${n}-${Date.now()}`).lastInsertRowid;
  db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, 1, 50)').run(pid);
  const created = await request(app).post('/api/orders').set(auth()).send({ name: 'CS Customer', phone: `07550009${String(n).padStart(2, '0')}`, city: 'Thika', payment_type: 'prepaid', assigned_staff_id: rep.id, items: [{ product_id: pid, quantity: 1 }] });
  await request(app).post(`/api/orders/${created.body.data.id}/dispatch`).set(auth());
  return created.body.data.id;
}
