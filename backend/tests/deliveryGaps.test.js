const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const orgs = require('../src/services/courierOrganizations.service');
const reconciliation = require('../src/services/paymentReconciliation.service');
const { moneyAtRisk } = require('../src/services/atRisk.service');
const { runIntegrityChecks } = require('../src/integrity/checks');
const courierPayables = require('../src/services/courierPayables.service');
const rule12 = () => runIntegrityChecks().violations.filter((v) => v.rule === 12);
const { profitLoss } = require('../src/services/reportsPnl.service');
const { localDate } = require('../src/utils/storeTime');

let adminToken; let adminId; let storeId; let cashier; let manager; let manager2; let product; let rider; let org; let seq = 0;
const FEE = 30000;
const auth = (t) => ({ Authorization: `Bearer ${t}` });

function makeUser(role, email) {
  const r = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(storeId, `${role} gaps`, email, bcrypt.hashSync('Passw0rd!Passw0rd', 10), role);
  return request(app).post('/api/auth/login').send({ email, password: 'Passw0rd!Passw0rd' }).then((l) => ({ id: r.lastInsertRowid, token: l.body.token }));
}

async function makeOrder(courierId, { cod = false } = {}) {
  const res = await request(app).post('/api/orders').set(auth(adminToken)).send({
    name: 'Gaps Customer', phone: `07449${String(70000 + (seq += 1))}`, city: 'Nairobi', payment_type: cod ? 'cod' : 'prepaid',
    items: [{ product_id: product.id, quantity: 1 }],
  });
  expect(res.status).toBe(201);
  db.prepare('UPDATE orders SET delivery_fee = ? WHERE id = ?').run(FEE, res.body.data.id);
  expect((await request(app).post(`/api/orders/${res.body.data.id}/courier`).set(auth(adminToken)).send({ courier_id: courierId })).status).toBe(200);
  if (cod) expect((await request(app).post(`/api/orders/${res.body.data.id}/confirm-cod`).set(auth(adminToken))).status).toBe(200);
  return res.body.data;
}
const dispatch = (id, body, token = adminToken) => request(app).post(`/api/orders/${id}/dispatch`).set(auth(token)).send(body);
const settlement = async (id) => (await request(app).get(`/api/orders/${id}/delivery`).set(auth(adminToken))).body.data;
const receiptsOf = (orderId) => db.prepare('SELECT * FROM delivery_fee_receipts WHERE order_id = ?').all(orderId);
const verifyOf = (receiptId) => db.prepare('SELECT * FROM delivery_fee_verifications WHERE receipt_id = ?').get(receiptId);
const days = (n) => new Date(Date.now() + n * 86_400_000);

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  const me = db.prepare(`SELECT id, store_id FROM users WHERE email = 'admin@urbantrends.com'`).get();
  adminId = me.id; storeId = me.store_id;
  cashier = await makeUser('cashier', 'gaps-cashier@urbantrends.com');
  manager = await makeUser('manager', 'gaps-manager@urbantrends.com');
  manager2 = await makeUser('manager', 'gaps-manager2@urbantrends.com');
  product = (await request(app).get('/api/products?pageSize=25').set(auth(adminToken))).body.data.find((p) => p.sell_price < 500000);
  db.prepare('UPDATE inventory SET quantity = 1000 WHERE product_id = ?').run(product.id);
  rider = (await request(app).post('/api/couriers').set(auth(adminToken)).send({ name: 'Gaps Rider', courier_type: 'boda' })).body.data;
  org = (await request(app).post('/api/couriers').set(auth(adminToken)).send({ name: 'Gaps Express', kind: 'organization', collects_payment: true })).body.data;
});
afterAll(() => cleanupTestDb());

describe('fee payments are checked against the money that really arrived', () => {
  it('a cash fee stays unverified until a manager confirms it was deposited, with a note', async () => {
    const o = await makeOrder(rider.id);
    await dispatch(o.id, { delivery_fee_paid: true, delivery_fee_collected: FEE, delivery_fee_method: 'cash' });
    const [r] = receiptsOf(o.id);
    expect(verifyOf(r.id)).toBeUndefined();
    expect((await settlement(o.id)).unverified_receipts).toBe(1);

    const noNote = await request(app).post(`/api/delivery/fee-receipts/${r.id}/verify`).set(auth(manager.token)).send({ note: ' ' });
    expect(noNote.status).toBe(400);
    expect((await request(app).post(`/api/delivery/fee-receipts/${r.id}/verify`).set(auth(cashier.token)).send({ note: 'ok' })).status).toBe(403);
    const ok = await request(app).post(`/api/delivery/fee-receipts/${r.id}/verify`).set(auth(manager.token)).send({ note: 'Deposit slip DS-114' });
    expect(ok.status).toBe(201);
    expect(verifyOf(r.id)).toMatchObject({ via: 'deposit' });
    expect((await request(app).post(`/api/delivery/fee-receipts/${r.id}/verify`).set(auth(manager.token)).send({ note: 'again' })).status).toBe(409);
  });

  it('whoever recorded a fee payment cannot confirm it, except an administrator', async () => {
    const o = await makeOrder(rider.id);
    await dispatch(o.id, { delivery_fee_paid: false });
    const late = await request(app).post(`/api/orders/${o.id}/delivery/fee-receipts`).set(auth(manager.token)).send({ amount: 10000, method: 'cash' });
    expect(late.status).toBe(201);
    const [r] = receiptsOf(o.id);
    expect((await request(app).post(`/api/delivery/fee-receipts/${r.id}/verify`).set(auth(manager.token)).send({ note: 'self' })).status).toBe(403);
    expect((await request(app).post(`/api/delivery/fee-receipts/${r.id}/verify`).set(auth(manager2.token)).send({ note: 'second manager saw it' })).status).toBe(201);
  });

  it('a mobile-money fee needs its reference, which is checked against an incoming payment already received', async () => {
    const o = await makeOrder(rider.id);
    expect((await dispatch(o.id, { delivery_fee_paid: true, delivery_fee_collected: FEE, delivery_fee_method: 'mobile_money' })).status).toBe(422);

    reconciliation.ingestNotification({ storeId, source: 'mpesa', method: 'mobile_money', amount: FEE, externalReference: 'FEEA000001', narrative: 'delivery', payerName: 'Jane' });
    const res = await dispatch(o.id, { delivery_fee_paid: true, delivery_fee_collected: FEE, delivery_fee_method: 'mobile_money', delivery_fee_reference: 'feea000001' });
    expect(res.status).toBe(200);
    const [r] = receiptsOf(o.id);
    expect(verifyOf(r.id)).toMatchObject({ via: 'notification' });
    const n = db.prepare(`SELECT * FROM payment_notifications WHERE external_reference = 'FEEA000001'`).get();
    expect(n).toMatchObject({ status: 'matched', order_id: o.id, delivery_fee_receipt_id: r.id });
  });

  it('a payment that arrives AFTER the fee was entered is the fee, never a payment for the goods', async () => {
    const o = await makeOrder(rider.id, { cod: true });
    const code = db.prepare('SELECT product_code FROM orders WHERE id = ?').get(o.id).product_code;
    await dispatch(o.id, { delivery_fee_paid: true, delivery_fee_collected: FEE, delivery_fee_method: 'mobile_money', delivery_fee_reference: 'FEEB000002' });
    const [r] = receiptsOf(o.id);
    expect(verifyOf(r.id)).toBeUndefined();

    reconciliation.ingestNotification({ storeId, source: 'mpesa', method: 'mobile_money', amount: FEE, externalReference: 'FEEB000002', narrative: `${code} delivery fee`, payerName: 'Jane' });
    expect(db.prepare('SELECT amount_paid FROM orders WHERE id = ?').get(o.id).amount_paid).toBe(0);
    expect(verifyOf(r.id)).toMatchObject({ via: 'notification' });
  });

  it('a payment with the fee\'s reference but a different amount is held for a person, not applied', async () => {
    const o = await makeOrder(rider.id, { cod: true });
    const code = db.prepare('SELECT product_code FROM orders WHERE id = ?').get(o.id).product_code;
    await dispatch(o.id, { delivery_fee_paid: true, delivery_fee_collected: FEE, delivery_fee_method: 'mobile_money', delivery_fee_reference: 'FEEC000003' });
    const n = reconciliation.ingestNotification({ storeId, source: 'mpesa', method: 'mobile_money', amount: FEE - 5000, externalReference: 'FEEC000003', narrative: code, payerName: 'Jane' });
    expect(n.status).toBe('unmatched');
    expect(db.prepare('SELECT amount_paid FROM orders WHERE id = ?').get(o.id).amount_paid).toBe(0);
    expect(verifyOf(receiptsOf(o.id)[0].id)).toBeUndefined();
  });

  it('one payment reference cannot be counted twice', async () => {
    const a = await makeOrder(rider.id);
    await dispatch(a.id, { delivery_fee_paid: true, delivery_fee_collected: 10000, delivery_fee_method: 'bank_transfer', delivery_fee_reference: 'REF-DUP-1' });
    const b = await makeOrder(rider.id);
    const res = await dispatch(b.id, { delivery_fee_paid: true, delivery_fee_collected: 10000, delivery_fee_method: 'bank_transfer', delivery_fee_reference: 'ref-dup-1' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REFERENCE_ALREADY_USED');
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(b.id).status).toBe('awaiting_dispatch');
  });

  it('is flagged on the money-at-risk page once it has waited too long, and lists unverified payments', async () => {
    const o = await makeOrder(rider.id);
    await dispatch(o.id, { delivery_fee_paid: true, delivery_fee_collected: 12345, delivery_fee_method: 'cash' });
    expect(moneyAtRisk({ storeId }).some((i) => i.kind === 'delivery_fee_unverified' && i.order_id === o.id)).toBe(false);
    const hit = moneyAtRisk({ storeId, now: days(3) }).find((i) => i.kind === 'delivery_fee_unverified' && i.order_id === o.id);
    expect(hit).toMatchObject({ amount: 12345 });
    const list = await request(app).get('/api/delivery/fee-receipts/unverified').set(auth(manager.token));
    expect(list.body.rows.some((r) => r.order_id === o.id)).toBe(true);
  });
});

describe('closing: an unpaid fee is written off on purpose', () => {
  it('needs a reason when part of the fee is outstanding, then records it and leaves the result unchanged', async () => {
    const o = await makeOrder(rider.id);
    await dispatch(o.id, { package_fee: 10000, delivery_fee_paid: true, delivery_fee_collected: 10000, delivery_fee_method: 'cash' });
    await request(app).post(`/api/delivery/fee-receipts/${receiptsOf(o.id)[0].id}/verify`).set(auth(manager.token)).send({ note: 'deposited' });

    const none = await request(app).post(`/api/orders/${o.id}/delivery/close`).set(auth(manager.token)).send({});
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('FEE_OUTSTANDING');

    const closed = await request(app).post(`/api/orders/${o.id}/delivery/close`).set(auth(manager.token)).send({ write_off_reason: 'Customer refused the rest' });
    expect(closed.status).toBe(200);
    expect(closed.body.data.settlement).toMatchObject({ fee_written_off: FEE - 10000, write_off_reason: 'Customer refused the rest', result: 0 });

    const reopened = await request(app).post(`/api/orders/${o.id}/delivery/reopen`).set(auth(adminToken)).send({ reason: 'Customer paid after all' });
    expect(reopened.body.data.settlement.fee_written_off).toBe(0);
    expect(reopened.body.data.fee_outstanding).toBe(FEE - 10000);
  });
});

describe('who may approve', () => {
  const cost = (orderId, token) => request(app).post(`/api/orders/${orderId}/delivery/costs`).set(auth(token))
    .send({ kind: 'handling', amount: 1000, reason: 'Repacking', paid_via: 'cash' });

  it('an administrator may approve their own entry, a manager may not, and the log says so', async () => {
    const o = await makeOrder(rider.id);
    await dispatch(o.id, { delivery_fee_paid: false });
    const mine = await cost(o.id, adminToken);
    const ok = await request(app).post(`/api/delivery/costs/${mine.body.data.id}/approve`).set(auth(adminToken));
    expect(ok.status).toBe(200);
    const log = db.prepare(`SELECT changes FROM staff_logs WHERE entity_type = 'delivery_cost' AND entity_id = ? AND action = 'update'`).get(mine.body.data.id);
    expect(JSON.stringify(log)).toMatch(/self_decided/);

    const theirs = await cost(o.id, manager.token);
    expect((await request(app).post(`/api/delivery/costs/${theirs.body.data.id}/approve`).set(auth(manager.token))).status).toBe(403);
    expect((await request(app).post(`/api/delivery/costs/${theirs.body.data.id}/approve`).set(auth(manager2.token))).status).toBe(200);
  });
});

describe('correcting what a rider is owed', () => {
  const adjust = (orderId, body, token = cashier.token) => request(app).post(`/api/orders/${orderId}/delivery/adjustments`).set(auth(token)).send(body);
  const decideAdj = (id, token = manager.token) => request(app).post(`/api/delivery/adjustments/${id}/approve`).set(auth(token));
  const payout = (id, token = manager.token) => request(app).post(`/api/couriers/${id}/payouts`).set(auth(token)).send({ method: 'cash' });
  let r2;

  beforeAll(async () => {
    r2 = (await request(app).post('/api/couriers').set(auth(adminToken)).send({ name: 'Correction Rider', courier_type: 'boda' })).body.data;
  });

  it('a wrong package fee is corrected without touching the original, once approved, and needs a reason', async () => {
    const o = await makeOrder(r2.id);
    await dispatch(o.id, { package_fee: 10000, delivery_fee_paid: false });
    expect((await adjust(o.id, { target_type: 'package_fee', delta: 2000, reason: ' ' })).status).toBe(400);
    const a = await adjust(o.id, { target_type: 'package_fee', delta: 2000, reason: 'Rider charged for the extra stage' });
    expect(a.status).toBe(201);
    expect((await settlement(o.id)).package_fee).toBe(10000);       // pending: not counted
    expect((await decideAdj(a.body.data.id)).status).toBe(200);
    expect((await settlement(o.id)).package_fee).toBe(12000);
    expect(db.prepare('SELECT amount FROM package_fees WHERE order_id = ?').get(o.id).amount).toBe(10000);
    expect(() => db.prepare('UPDATE delivery_adjustments SET delta = 1 WHERE id = ?').run(a.body.data.id)).toThrow();
  });

  it('cannot take the amount below zero', async () => {
    const o = await makeOrder(r2.id);
    await dispatch(o.id, { package_fee: 5000, delivery_fee_paid: false });
    const res = await adjust(o.id, { target_type: 'package_fee', delta: -5001, reason: 'too much' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ADJUSTMENT_BELOW_ZERO');
  });

  it('a fee already paid out and then raised comes out in the rider\'s next payout, counted once in profit', async () => {
    const o = await makeOrder(r2.id);
    await dispatch(o.id, { package_fee: 8000, delivery_fee_paid: false });
    const pay1 = await payout(r2.id);
    expect(pay1.status).toBe(201);

    const a = await adjust(o.id, { target_type: 'package_fee', delta: 1500, reason: 'Underpaid: two stages' });
    await decideAdj(a.body.data.id);
    const bal = courierPayables.balance({ courierId: r2.id, storeId });
    expect(bal.fees_owed).toBe(1500);

    const range = { from: new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10), to: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10) };
    const before = profitLoss({ storeId, ...range });
    const pay2 = await payout(r2.id);
    expect(pay2.status).toBe(201);
    expect(pay2.body.data.total).toBe(1500);
    expect(pay2.body.data.adjustment_lines).toHaveLength(1);
    const after = profitLoss({ storeId, ...range });
    expect(after.netProfit).toBe(before.netProfit);                  // paying out does not charge it again
    expect(rule12()).toEqual([]);
  });

  it('a fee taken back after payout is held against the rider\'s next earnings', async () => {
    const o = await makeOrder(r2.id);
    await dispatch(o.id, { package_fee: 9000, delivery_fee_paid: false });
    await payout(r2.id);
    const a = await adjust(o.id, { target_type: 'package_fee', delta: -3000, reason: 'Fee was for a different parcel' });
    await decideAdj(a.body.data.id);

    const refused = await payout(r2.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PAYOUT_NOT_POSITIVE');

    const next = await makeOrder(r2.id);
    await dispatch(next.id, { package_fee: 10000, delivery_fee_paid: false });
    const ok = await payout(r2.id);
    expect(ok.status).toBe(201);
    expect(ok.body.data.total).toBe(7000);                           // 10000 earned, 3000 given back
    expect(rule12()).toEqual([]);
  });

  it('a rider cost approved wrongly is corrected through the same route', async () => {
    const o = await makeOrder(r2.id);
    await dispatch(o.id, { package_fee: 1000, delivery_fee_paid: false });
    const c = await request(app).post(`/api/couriers/${r2.id}/costs`).set(auth(cashier.token))
      .send({ kind: 'fuel', amount: 4000, description: 'Fuel', order_id: o.id });
    expect(c.status).toBe(201);
    await request(app).post(`/api/couriers/costs/${c.body.data.id}/approve`).set(auth(manager.token));
    const a = await adjust(o.id, { target_type: 'courier_cost', cost_id: c.body.data.id, delta: -1500, reason: 'Receipt was for KES 25' });
    expect(a.status).toBe(201);
    await decideAdj(a.body.data.id);
    expect((await settlement(o.id)).rider_costs).toBe(2500);
    const other = await makeOrder(r2.id);
    await dispatch(other.id, { delivery_fee_paid: false });
    expect((await adjust(other.id, { target_type: 'courier_cost', cost_id: c.body.data.id, delta: -100, reason: 'wrong order' })).status).toBe(404);
  });
});

describe('legs a courier organization deducts from what it remits', () => {
  const today = () => localDate(0);
  async function orgParcel(fee = 20000) {
    const o = await makeOrder(org.id, { cod: true });
    expect((await dispatch(o.id, { package_fee: fee, delivery_fee_paid: false })).status).toBe(200);
    const total = db.prepare('SELECT total FROM orders WHERE id = ?').get(o.id).total;
    const col = orgs.recordCollection({ storeId, staffId: adminId, courierId: org.id, orderId: o.id, amount: total, collectedOn: today() });
    return { o, total, col };
  }
  const statement = (cols, extra = {}) => orgs.createStatement({
    storeId, staffId: adminId, courierId: org.id, periodStart: localDate(7), periodEnd: today(), collectionIds: cols.map((c) => c.id), chargeEntered: 0, remitted: 0, ...extra,
  });
  const addDeducted = (orderId, amount) => request(app).post(`/api/orders/${orderId}/delivery/costs`).set(auth(cashier.token))
    .send({ kind: 'outpost_leg', amount, reason: 'Outpost to Busia, kept by the organization', paid_via: 'deducted_by_courier' });

  it('only an organization can deduct a cost', async () => {
    const o = await makeOrder(rider.id);
    await dispatch(o.id, { delivery_fee_paid: false });
    const res = await addDeducted(o.id, 5000);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DEDUCTION_NEEDS_ORGANIZATION');
  });

  it('is netted off the next statement with the package fee, once, and counted in the delivery cost', async () => {
    const { o, total, col } = await orgParcel(20000);
    const rec = await addDeducted(o.id, 12000);
    await request(app).post(`/api/delivery/costs/${rec.body.data.id}/approve`).set(auth(manager.token));
    expect((await settlement(o.id)).costs_total).toBe(20000 + 12000);

    const st = statement([col], { remitted: total - 32000 });
    expect(st.fees).toBe(32000);                                      // package fee + the deducted leg
    expect(st.cash_variance).toBe(0);                                  // nothing looks owed by the organization
    expect(db.prepare('SELECT netted_payout_id FROM delivery_costs WHERE id = ?').get(rec.body.data.id).netted_payout_id).toBe(st.payout_id);

    const { o: o2, total: t2, col: col2 } = await orgParcel(20000);
    const st2 = statement([col2], { remitted: t2 - 20000 });
    expect(st2.fees).toBe(20000);                                      // the earlier leg is not netted again
    void o2;
  });

  it('a reversal after the leg was netted comes back as a credit on the next statement', async () => {
    const { o, total, col } = await orgParcel(20000);
    const rec = await addDeducted(o.id, 10000);
    await request(app).post(`/api/delivery/costs/${rec.body.data.id}/approve`).set(auth(manager.token));
    statement([col], { remitted: total - 30000 });

    const rev = await request(app).post(`/api/delivery/costs/${rec.body.data.id}/reverse`).set(auth(cashier.token)).send({ amount: 4000, reason: 'Organization refunded part of the leg' });
    expect(rev.status).toBe(201);
    await request(app).post(`/api/delivery/costs/${rev.body.data.id}/approve`).set(auth(manager.token));

    const { total: t2, col: col2 } = await orgParcel(20000);
    const st = statement([col2], { remitted: t2 - 16000 });
    expect(st.fees).toBe(20000 - 4000);
  });
});

describe('open deliveries and pending approvals are flagged as they age', () => {
  it('flags an open settlement after two weeks and a pending cost after a day', async () => {
    const o = await makeOrder(rider.id);
    await dispatch(o.id, { delivery_fee_paid: false });
    const pending = await request(app).post(`/api/orders/${o.id}/delivery/costs`).set(auth(cashier.token))
      .send({ kind: 'storage', amount: 700, reason: 'Held at outpost', paid_via: 'cash' });
    expect(pending.status).toBe(201);

    const fresh = moneyAtRisk({ storeId });
    expect(fresh.some((i) => i.order_id === o.id && i.kind.startsWith('delivery_'))).toBe(false);
    const day2 = moneyAtRisk({ storeId, now: days(2) });
    expect(day2.some((i) => i.kind === 'delivery_cost_pending' && i.order_id === o.id)).toBe(true);
    const day20 = moneyAtRisk({ storeId, now: days(20) });
    expect(day20.some((i) => i.kind === 'delivery_settlement_open' && i.order_id === o.id)).toBe(true);
  });
});
