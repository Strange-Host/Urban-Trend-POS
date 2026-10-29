const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

let adminToken;
let manager;
let manager2;
let cashier;
let product;
let courier;
let phoneSeq = 0;

const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function makeUser(role, email) {
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  const r = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(store.id, `${role} pay`, email, bcrypt.hashSync('Passw0rd!Passw0rd', 10), role);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Passw0rd!Passw0rd' });
  return { id: r.lastInsertRowid, token: login.body.token };
}

// A prepaid order with the courier already picked, ready to dispatch.
async function makeOrder({ withCourier = true } = {}) {
  const res = await request(app).post('/api/orders').set(auth(adminToken)).send({
    name: 'Payables Customer', phone: `07117${String(70000 + (phoneSeq += 1))}`, city: 'Nairobi', payment_type: 'prepaid',
    items: [{ product_id: product.id, quantity: 1 }],
  });
  expect(res.status).toBe(201);
  const order = res.body.data;
  if (withCourier) {
    const set = await request(app).post(`/api/orders/${order.id}/courier`).set(auth(adminToken)).send({ courier_id: courier.id });
    expect(set.status).toBe(200);
  }
  return order;
}

const dispatch = (orderId, body = {}) => request(app).post(`/api/orders/${orderId}/dispatch`).set(auth(adminToken)).send(body);
const balance = async () => (await request(app).get(`/api/couriers/${courier.id}/payables`).set(auth(adminToken))).body.data;

async function approvedCost(amount, kind = 'fuel') {
  const rec = await request(app).post(`/api/couriers/${courier.id}/costs`).set(auth(cashier.token))
    .send({ kind, amount, description: `${kind} run` });
  expect(rec.status).toBe(201);
  const ok = await request(app).post(`/api/couriers/costs/${rec.body.data.id}/approve`).set(auth(manager.token));
  expect(ok.status).toBe(200);
  return ok.body.data;
}

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  cashier = await makeUser('cashier', 'pay-cashier@urbantrends.com');
  manager = await makeUser('manager', 'pay-manager@urbantrends.com');
  manager2 = await makeUser('manager', 'pay-manager2@urbantrends.com');
  product = (await request(app).get('/api/products?pageSize=1').set(auth(adminToken))).body.data[0];
  db.prepare('UPDATE inventory SET quantity = 1000 WHERE product_id = ?').run(product.id);
  courier = (await request(app).post('/api/couriers').set(auth(adminToken)).send({ name: 'Pay Rider', courier_type: 'boda' })).body.data;
});

afterAll(() => cleanupTestDb());

describe('package fees', () => {
  it('is entered at dispatch and owed immediately', async () => {
    const order = await makeOrder();
    const res = await dispatch(order.id, { package_fee: 15000 });
    expect(res.status).toBe(200);
    const fee = db.prepare('SELECT * FROM package_fees WHERE order_id = ?').get(order.id);
    expect(fee).toMatchObject({ courier_id: courier.id, amount: 15000 });
    expect((await balance()).fees_owed).toBeGreaterThanOrEqual(15000);
  });

  it('is still owed when the parcel comes back (never collected)', async () => {
    const order = await makeOrder();
    await dispatch(order.id, { package_fee: 20000 });
    const before = (await balance()).fees_owed;
    const back = await request(app).post(`/api/orders/${order.id}/returned-in-transit`).set(auth(adminToken)).send({});
    expect(back.status).toBe(200);
    expect((await balance()).fees_owed).toBe(before);
  });

  it('a fee needs a named courier, and a refused fee rolls the whole dispatch back', async () => {
    const order = await makeOrder({ withCourier: false });
    const res = await dispatch(order.id, { package_fee: 5000 });
    expect(res.status).toBe(409);
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status).toBe('awaiting_dispatch');
    expect(db.prepare('SELECT COUNT(*) AS n FROM package_fees WHERE order_id = ?').get(order.id).n).toBe(0);
  });

  it('rejects a negative or fractional fee; dispatch without a fee still works', async () => {
    const order = await makeOrder();
    expect((await dispatch(order.id, { package_fee: -1 })).status).toBe(422);
    expect((await dispatch(order.id, { package_fee: 10.5 })).status).toBe(422);
    expect((await dispatch(order.id)).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM package_fees WHERE order_id = ?').get(order.id).n).toBe(0);
  });

  it('a zero rider fee owes nothing and is not recorded', async () => {
    const order = await makeOrder();
    const before = (await balance()).fees_owed;
    expect((await dispatch(order.id, { package_fee: 0 })).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM package_fees WHERE order_id = ?').get(order.id).n).toBe(0);
    expect((await balance()).fees_owed).toBe(before);
  });

  it('leaves a courier organization to its own rules: one fee row, required, never paid out here', async () => {
    const org = (await request(app).post('/api/couriers').set(auth(adminToken))
      .send({ name: 'Pay Org Ltd', courier_type: 'g4s', kind: 'organization' })).body.data;
    expect(org.kind).toBe('organization');
    const order = await makeOrder({ withCourier: false });
    await request(app).post(`/api/orders/${order.id}/courier`).set(auth(adminToken)).send({ courier_id: org.id });
    expect((await dispatch(order.id)).status).toBe(422); // their rule: an organization's fee is required
    expect((await dispatch(order.id, { package_fee: 7000 })).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n, MAX(amount) AS a FROM package_fees WHERE order_id = ?').get(order.id)).toEqual({ n: 1, a: 7000 });
    expect((await request(app).get(`/api/couriers/${org.id}/payables`).set(auth(adminToken))).status).toBe(409);
    expect((await request(app).post(`/api/couriers/${org.id}/costs`).set(auth(adminToken)).send({ kind: 'fuel', amount: 100, description: 'x' })).status).toBe(409);
  });
});

describe('courier costs need a second person', () => {
  let costId;

  it('anyone can enter a cost; it owes nothing while pending', async () => {
    const before = (await balance()).costs_owed;
    const res = await request(app).post(`/api/couriers/${courier.id}/costs`).set(auth(cashier.token))
      .send({ kind: 'fuel', amount: 30000, description: 'Fuel for Thika run', receipt_ref: 'R-1' });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('pending');
    costId = res.body.data.id;
    const b = await balance();
    expect(b.costs_owed).toBe(before);
    expect(b.pending_costs).toBeGreaterThanOrEqual(1);
  });

  it('validates the cost', async () => {
    const post = (body) => request(app).post(`/api/couriers/${courier.id}/costs`).set(auth(cashier.token)).send(body);
    expect((await post({ kind: 'fuel', amount: 0, description: 'x' })).status).toBe(400);
    expect((await post({ kind: 'bribe', amount: 100, description: 'x' })).status).toBe(400);
    expect((await post({ kind: 'fuel', amount: 100, description: '  ' })).status).toBe(400);
    expect((await request(app).post('/api/couriers/99999/costs').set(auth(cashier.token)).send({ kind: 'fuel', amount: 100, description: 'x' })).status).toBe(404);
  });

  it('the person who entered it cannot approve or reject it', async () => {
    const mine = await request(app).post(`/api/couriers/${courier.id}/costs`).set(auth(manager.token))
      .send({ kind: 'airtime', amount: 5000, description: 'Airtime' });
    expect((await request(app).post(`/api/couriers/costs/${mine.body.data.id}/approve`).set(auth(manager.token))).status).toBe(403);
    expect((await request(app).post(`/api/couriers/costs/${mine.body.data.id}/reject`).set(auth(manager.token)).send({ reason: 'no' })).status).toBe(403);
    expect(db.prepare('SELECT status FROM courier_costs WHERE id = ?').get(mine.body.data.id).status).toBe('pending');
  });

  it('a cashier cannot approve', async () => {
    expect((await request(app).post(`/api/couriers/costs/${costId}/approve`).set(auth(cashier.token))).status).toBe(403);
  });

  it('another person approves it and it becomes owed', async () => {
    const before = (await balance()).costs_owed;
    const res = await request(app).post(`/api/couriers/costs/${costId}/approve`).set(auth(manager.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'approved' });
    expect((await balance()).costs_owed).toBe(before + 30000);
  });

  it('a decided cost cannot be decided again', async () => {
    expect((await request(app).post(`/api/couriers/costs/${costId}/approve`).set(auth(manager2.token))).status).toBe(409);
    expect((await request(app).post(`/api/couriers/costs/${costId}/reject`).set(auth(manager2.token)).send({ reason: 'late' })).status).toBe(409);
  });

  it('a rejection needs a reason and owes nothing', async () => {
    const rec = await request(app).post(`/api/couriers/${courier.id}/costs`).set(auth(cashier.token))
      .send({ kind: 'other', amount: 99900, description: 'Unexplained' });
    const before = (await balance()).costs_owed;
    expect((await request(app).post(`/api/couriers/costs/${rec.body.data.id}/reject`).set(auth(manager.token)).send({})).status).toBe(400);
    const res = await request(app).post(`/api/couriers/costs/${rec.body.data.id}/reject`).set(auth(manager.token)).send({ reason: 'No receipt' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'rejected', decision_reason: 'No receipt' });
    expect((await balance()).costs_owed).toBe(before);
  });

  it('the database itself refuses a self-decided cost', () => {
    const row = db.prepare(`SELECT id, recorded_by FROM courier_costs WHERE status = 'pending' LIMIT 1`).get();
    expect(() => db.prepare(`UPDATE courier_costs SET status = 'approved', decided_by = recorded_by WHERE id = ?`).run(row.id)).toThrow();
  });
});

describe('payouts', () => {
  let rider;
  let feeA;
  let feeB;

  // A clean courier so totals are exact.
  beforeAll(async () => {
    rider = (await request(app).post('/api/couriers').set(auth(adminToken)).send({ name: 'Exact Rider', courier_type: 'boda' })).body.data;
    for (const fee of [10000, 25000]) {
      const o = await makeOrder({ withCourier: false });
      await request(app).post(`/api/orders/${o.id}/courier`).set(auth(adminToken)).send({ courier_id: rider.id });
      expect((await dispatch(o.id, { package_fee: fee })).status).toBe(200);
    }
    [feeA, feeB] = db.prepare('SELECT id FROM package_fees WHERE courier_id = ? ORDER BY id').all(rider.id).map((r) => r.id);
    const rec = await request(app).post(`/api/couriers/${rider.id}/costs`).set(auth(cashier.token)).send({ kind: 'return_trip', amount: 8000, description: 'Return trip' });
    await request(app).post(`/api/couriers/costs/${rec.body.data.id}/approve`).set(auth(manager.token));
  });

  const pay = (body, token = manager.token) => request(app).post(`/api/couriers/${rider.id}/payouts`).set(auth(token)).send(body);

  it('shows fees and costs as separate lines in what is owed', async () => {
    const b = (await request(app).get(`/api/couriers/${rider.id}/payables`).set(auth(manager.token))).body.data;
    expect(b).toMatchObject({ fees_owed: 35000, costs_owed: 8000, total_owed: 43000 });
    expect(b.items.map((i) => i.type).sort()).toEqual(['courier_cost', 'package_fee', 'package_fee']);
  });

  it('needs the permission; a cashier cannot see or pay', async () => {
    expect((await pay({ method: 'cash' }, cashier.token)).status).toBe(403);
    expect((await request(app).get(`/api/couriers/${rider.id}/payables`).set(auth(cashier.token))).status).toBe(403);
  });

  it('mpesa and bank need a reference; the method must be valid', async () => {
    expect((await pay({ method: 'mpesa' })).status).toBe(422);
    expect((await pay({ method: 'bank', payment_ref: '  ' })).status).toBe(422);
    expect((await pay({ method: 'paypal' })).status).toBe(400);
  });

  it('refuses items that are not unpaid for this courier, or listed twice', async () => {
    expect((await pay({ method: 'cash', items: [{ type: 'package_fee', id: 999999 }] })).status).toBe(409);
    expect((await pay({ method: 'cash', items: [{ type: 'package_fee', id: feeA }, { type: 'package_fee', id: feeA }] })).status).toBe(422);
  });

  it('pays chosen items only; the total is the sum of the items', async () => {
    const res = await pay({ method: 'mpesa', payment_ref: 'QWE123', items: [{ type: 'package_fee', id: feeA }] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ fees_total: 10000, costs_total: 0, total: 10000, method: 'mpesa', payment_ref: 'QWE123' });
    expect(res.body.data.fee_lines).toHaveLength(1);
    expect(res.body.data.cost_lines).toHaveLength(0);
    expect((await request(app).get(`/api/couriers/${rider.id}/payables`).set(auth(manager.token))).body.data.total_owed).toBe(33000);
  });

  it('cannot pay the same item twice', async () => {
    expect((await pay({ method: 'cash', items: [{ type: 'package_fee', id: feeA }] })).status).toBe(409);
    expect(() => db.prepare('INSERT INTO rider_payout_items (payout_id, package_fee_id, amount) SELECT payout_id, package_fee_id, amount FROM rider_payout_items WHERE package_fee_id = ?').run(feeA)).toThrow();
  });

  it('with no items pays everything left, fees and costs on separate lines and in separate expense rows', async () => {
    const res = await pay({ method: 'cash' });
    expect(res.status).toBe(201);
    const p = res.body.data;
    expect(p).toMatchObject({ fees_total: 25000, costs_total: 8000, total: 33000 });
    expect(p.fee_lines.map((l) => l.amount)).toEqual([25000]);
    expect(p.cost_lines.map((l) => [l.kind, l.amount])).toEqual([['return_trip', 8000]]);

    const fees = db.prepare('SELECT e.amount, c.name FROM expenses e JOIN expense_categories c ON c.id = e.category_id WHERE e.id = ?').get(p.fees_expense_id);
    const costs = db.prepare('SELECT e.amount, c.name FROM expenses e JOIN expense_categories c ON c.id = e.category_id WHERE e.id = ?').get(p.costs_expense_id);
    expect(fees).toEqual({ amount: 25000, name: 'Courier package fees' });
    expect(costs).toEqual({ amount: 8000, name: 'Courier costs' });
    expect((await request(app).get(`/api/couriers/${rider.id}/payables`).set(auth(manager.token))).body.data.total_owed).toBe(0);
  });

  it('refuses a payout when nothing is due', async () => {
    expect((await pay({ method: 'cash' })).status).toBe(409);
  });

  it('lists payouts and returns one with its lines; shows in the overview only while owing', async () => {
    const list = (await request(app).get(`/api/couriers/payouts?courier_id=${rider.id}`).set(auth(manager.token))).body.data;
    expect(list).toHaveLength(2);
    const one = (await request(app).get(`/api/couriers/payouts/${list[0].id}`).set(auth(manager.token))).body.data;
    expect(one.courier_name).toBe('Exact Rider');
    const overview = (await request(app).get('/api/couriers/payables').set(auth(manager.token))).body.data;
    expect(overview.find((c) => c.courier.id === rider.id)).toBeUndefined();
  });

  it('a payout for a cost-only settlement creates no fee expense', async () => {
    const c = await approvedCost(4000, 'airtime');
    const res = await request(app).post(`/api/couriers/${courier.id}/payouts`).set(auth(manager.token))
      .send({ method: 'cash', items: [{ type: 'courier_cost', id: c.id }] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ fees_total: 0, costs_total: 4000, fees_expense_id: null });
    expect(res.body.data.costs_expense_id).not.toBeNull();
  });
});
