const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const { moneyAtRisk, summarize } = require('../src/services/atRisk.service');
const reconciliation = require('../src/services/paymentReconciliation.service');

let token;
let product;
let storeId;
let adminId;

const auth = () => ({ Authorization: `Bearer ${token}` });
const days = (n) => new Date(Date.now() + n * 86_400_000);
const kinds = (items) => items.map((i) => i.kind);
const byKind = (items, k) => items.filter((i) => i.kind === k);

beforeAll(async () => {
  token = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=1').set(auth());
  product = res.body.data[0];
  const admin = db.prepare(`SELECT id, store_id FROM users WHERE email = 'admin@urbantrends.com'`).get();
  adminId = admin.id;
  storeId = admin.store_id;
});

afterAll(() => cleanupTestDb());

// A prepaid order straight to "dispatched" (nothing paid yet, so dispatched_unpaid).
async function dispatched(phone, { assignedStaffId } = {}) {
  const create = await request(app).post('/api/orders').set(auth())
    .send({ name: 'Risk Test', phone, payment_type: 'prepaid', assigned_staff_id: assignedStaffId, items: [{ product_id: product.id, quantity: 1 }] });
  const order = create.body.data;
  await request(app).post(`/api/orders/${order.id}/dispatch`).set(auth());
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
}

const pay = (orderId, amount) => request(app).post(`/api/orders/${orderId}/payments`).set(auth()).send({ method: 'cash', amount });

describe('money at risk', () => {
  it('is empty for a healthy, fresh system, however old it gets', async () => {
    const o = await dispatched('0777100001');
    await pay(o.id, o.total); // fully paid -> dispatched_paid
    expect(moneyAtRisk({ storeId })).toEqual([]);
    expect(moneyAtRisk({ storeId, now: days(60) })).toEqual([]);
  });

  it('flags every kind with its age, amount and owner, oldest first, and leaves healthy orders out', async () => {
    const stuck = await dispatched('0777100002', { assignedStaffId: adminId });   // dispatched, nothing heard
    const partial = await dispatched('0777100003');                                // part paid
    await pay(partial.id, Math.floor(partial.total / 2));
    const coming = await dispatched('0777100004');                                 // refused, on its way back
    await request(app).post(`/api/orders/${coming.id}/returned-in-transit`).set(auth()).send({ reason_code: 'rejected' });
    const healthy = await dispatched('0777100005');                               // fully paid: must NOT appear
    await pay(healthy.id, healthy.total);

    reconciliation.ingestNotification({ storeId, source: 'mpesa', method: 'mobile_money', amount: 7777, externalReference: 'LOST000001', narrative: 'no code here', payerName: 'Stranger' });
    db.prepare(`INSERT INTO cash_sessions (store_id, user_id, opening_amount) VALUES (?, ?, 50000)`).run(storeId, adminId);

    const items = moneyAtRisk({ storeId, now: days(10) });

    expect(byKind(items, 'dispatched_no_outcome')).toEqual([expect.objectContaining({ order_id: stuck.id, amount: stuck.total, owner: expect.any(String) })]);
    expect(byKind(items, 'delivered_unpaid')).toEqual([expect.objectContaining({ order_id: partial.id, amount: partial.total - Math.floor(partial.total / 2) })]);
    expect(byKind(items, 'returning')).toEqual([expect.objectContaining({ order_id: coming.id, amount: coming.total })]);
    expect(byKind(items, 'unmatched_payment')).toEqual([expect.objectContaining({ amount: 7777, order_id: null, detail: expect.stringContaining('LOST000001') })]);
    expect(byKind(items, 'till_session_left_open')).toHaveLength(1);
    expect(items.map((i) => i.order_id)).not.toContain(healthy.id);

    expect(items.every((i) => i.age_days >= 9)).toBe(true);
    for (let i = 1; i < items.length; i++) expect(items[i - 1].age_days).toBeGreaterThanOrEqual(items[i].age_days);

    const s = summarize(items);
    expect(s.count).toBe(items.length);
    expect(s.by_kind.unmatched_payment).toEqual({ count: 1, amount: 7777 });
  });

  it('respects the thresholds: recent items are not flagged yet, but unmatched money always is', () => {
    expect(new Set(kinds(moneyAtRisk({ storeId })))).toEqual(new Set(['unmatched_payment']));
    const tight = moneyAtRisk({ storeId, now: days(1), dispatchedNoOutcomeDays: 0, deliveredUnpaidDays: 0, returningDays: 0, sessionOpenHours: 0 });
    expect(new Set(kinds(tight))).toEqual(new Set(['dispatched_no_outcome', 'delivered_unpaid', 'returning', 'unmatched_payment', 'till_session_left_open']));
  });

  it('ignores a bad override and keeps the default', () => {
    expect(moneyAtRisk({ storeId, dispatchedNoOutcomeDays: -5, deliveredUnpaidDays: NaN })).toEqual(moneyAtRisk({ storeId }));
  });

  it('an order drops off once it is paid, and a till once it is closed', async () => {
    const stuck = byKind(moneyAtRisk({ storeId, now: days(10) }), 'dispatched_no_outcome')[0];
    const order = db.prepare('SELECT total FROM orders WHERE id = ?').get(stuck.order_id);
    await pay(stuck.order_id, order.total);
    db.prepare(`UPDATE cash_sessions SET closed_at = datetime('now') WHERE closed_at IS NULL`).run();
    const after = moneyAtRisk({ storeId, now: days(10) });
    expect(after.map((i) => i.order_id)).not.toContain(stuck.order_id);
    expect(kinds(after)).not.toContain('till_session_left_open');
  });

  it('an unmatched payment drops off once it is ignored', () => {
    const row = db.prepare(`SELECT id FROM payment_notifications WHERE external_reference = 'LOST000001'`).get();
    reconciliation.ignore({ notificationId: row.id, staffId: adminId, storeId, notes: 'test' });
    expect(kinds(moneyAtRisk({ storeId, now: days(10) }))).not.toContain('unmatched_payment');
  });

  it('only counts this store', () => {
    expect(moneyAtRisk({ storeId: storeId + 999, now: days(60) })).toEqual([]);
  });
});

describe('GET /api/orders/at-risk', () => {
  it('returns the list and a summary to an admin, and is not swallowed by /orders/:id', async () => {
    const res = await request(app).get('/api/orders/at-risk?dispatched_no_outcome_days=0').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.summary).toEqual(expect.objectContaining({ count: res.body.data.length, by_kind: expect.any(Object) }));
  });

  it('is refused for a cashier', async () => {
    const email = 'atrisk-cashier@urbantrends.com';
    db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'Cashier Risk', ?, ?, 'cashier', 1)`)
      .run(storeId, email, bcrypt.hashSync('Passw0rd!Passw0rd', 10));
    const login = await request(app).post('/api/auth/login').send({ email, password: 'Passw0rd!Passw0rd' });
    const res = await request(app).get('/api/orders/at-risk').set({ Authorization: `Bearer ${login.body.token}` });
    expect(res.status).toBe(403);
  });
});

// ---- courier unpaid and organization overdue: built on rider payables and courier organizations ----------------------
describe('courier money', () => {
  const payables = require('../src/services/courierPayables.service');
  const orgs = require('../src/services/courierOrganizations.service');
  const { localDate } = require('../src/utils/storeTime');
  let seq = 0;
  let secondUserId;

  beforeAll(() => {
    secondUserId = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'Cost Approver', 'approver@urbantrends.com', 'x', 'manager', 1)`)
      .run(storeId).lastInsertRowid;
  });

  const newCourier = async (body) => (await request(app).post('/api/couriers').set(auth()).send({ name: `Risk Courier ${Date.now()}-${++seq}`, ...body })).body.data;
  async function dispatchVia(courierId, fee) {
    const created = await request(app).post('/api/orders').set(auth())
      .send({ name: 'Courier Risk', phone: `07880${String(++seq).padStart(5, '0')}`, city: 'Nairobi', items: [{ product_id: product.id, quantity: 1 }] });
    const id = created.body.data.id;
    await request(app).post(`/api/orders/${id}/courier`).set(auth()).send({ courier_id: courierId });
    await request(app).post(`/api/orders/${id}/confirm-cod`).set(auth());
    const res = await request(app).post(`/api/orders/${id}/dispatch`).set(auth()).send({ package_fee: fee });
    expect(res.status).toBe(200);
    return { id, total: created.body.data.total };
  }

  it('courier unpaid: one line per rider, aged by the oldest unpaid item, until paid', async () => {
    const rider = await newCourier({ kind: 'rider', courier_type: 'boda' });
    await dispatchVia(rider.id, 15_000);
    const cost = payables.recordCost({ storeId, staffId: adminId, courierId: rider.id, kind: 'fuel', amount: 5_000, description: 'Fuel' });
    const mine = (now) => byKind(moneyAtRisk({ storeId, now }), 'courier_unpaid').filter((i) => i.detail.includes(rider.name));

    // The fee is owed whether or not the customer collected; the pending cost is not owed until a second person approves it.
    expect(mine(days(30))).toEqual([expect.objectContaining({ amount: 15_000, detail: `We owe ${rider.name} for 1 unpaid item` })]);
    payables.approveCost({ costId: cost.id, storeId, staffId: secondUserId });
    expect(mine(days(3))).toEqual([]);                                   // under the 7-day threshold: not flagged yet
    const flagged = mine(days(8));
    expect(flagged).toEqual([expect.objectContaining({ amount: 20_000, owner: null, order_id: null, detail: `We owe ${rider.name} for 2 unpaid items` })]);
    expect(flagged[0].age_days).toBeGreaterThanOrEqual(7);

    payables.createPayout({ storeId, staffId: adminId, courierId: rider.id, method: 'cash' });
    expect(mine(days(30))).toEqual([]);                                  // paid: gone
  });

  it('courier unpaid: a zero fee, a pending cost and an organization owe nothing here', async () => {
    const rider = await newCourier({ kind: 'rider', courier_type: 'boda' });
    await dispatchVia(rider.id, 0);
    payables.recordCost({ storeId, staffId: adminId, courierId: rider.id, kind: 'airtime', amount: 900, description: 'Airtime' }); // never approved
    const org = await newCourier({ kind: 'organization', collects_payment: true });
    await dispatchVia(org.id, 12_000);
    const items = byKind(moneyAtRisk({ storeId, now: days(30) }), 'courier_unpaid');
    expect(items.filter((i) => i.detail.includes(rider.name))).toEqual([]);
    expect(items.filter((i) => i.detail.includes(org.name))).toEqual([]);  // an organization's fee is netted off its statement, not paid out
  });

  it('organization overdue: money held past the limit is flagged, with a pause note, until it is remitted', async () => {
    const org = await newCourier({ kind: 'organization', collects_payment: true, overdue_after_days: 5, overdue_limit: 1_000 });
    const o = await dispatchVia(org.id, 20_000);
    const col = orgs.recordCollection({ storeId, staffId: adminId, courierId: org.id, orderId: o.id, amount: o.total, collectedOn: localDate(20) });
    const mine = () => byKind(moneyAtRisk({ storeId }), 'organization_overdue').filter((i) => i.detail.includes(org.name));

    expect(mine()).toEqual([expect.objectContaining({
      amount: o.total, owner: null, detail: `${org.name} holds overdue money and is paused for new collect-on-delivery parcels`,
    })]);
    expect(mine()[0].age_days).toBeGreaterThanOrEqual(19);

    orgs.createStatement({ storeId, staffId: adminId, courierId: org.id, periodStart: localDate(30), periodEnd: localDate(0), collectionIds: [col.id],
      chargeEntered: 20_000, remitted: o.total - 20_000, remittanceRef: 'RMT-RISK' });
    expect(mine()).toEqual([]);                                          // remitted: gone
  });

  it('organization overdue: recent money, or an organization with no limit and nothing overdue, is not flagged', async () => {
    const org = await newCourier({ kind: 'organization', collects_payment: true, overdue_after_days: 14 });
    const o = await dispatchVia(org.id, 20_000);
    orgs.recordCollection({ storeId, staffId: adminId, courierId: org.id, orderId: o.id, amount: o.total, collectedOn: localDate(3) });
    expect(byKind(moneyAtRisk({ storeId }), 'organization_overdue').filter((i) => i.detail.includes(org.name))).toEqual([]);
  });

  it('the summary and the endpoint know both kinds', async () => {
    const s = summarize([]);
    expect(Object.keys(s.by_kind)).toEqual(expect.arrayContaining(['courier_unpaid', 'organization_overdue']));
    const res = await request(app).get('/api/orders/at-risk?courier_unpaid_days=0').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.summary.by_kind.courier_unpaid).toBeDefined();
  });
});
