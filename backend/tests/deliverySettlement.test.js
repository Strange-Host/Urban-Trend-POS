const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const { profitLoss } = require('../src/services/reportsPnl.service');

let adminToken;
let cashier;
let manager;
let product;
let rider;
let org;
let seq = 0;
const FEE = 30000; // KES 300 delivery fee, in cents
const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function makeUser(role, email) {
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  const r = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(store.id, `${role} settle`, email, bcrypt.hashSync('Passw0rd!Passw0rd', 10), role);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Passw0rd!Passw0rd' });
  return { id: r.lastInsertRowid, token: login.body.token };
}

async function makeOrder(courierId = rider.id) {
  const res = await request(app).post('/api/orders').set(auth(adminToken)).send({
    name: 'Settle Customer', phone: `07226${String(60000 + (seq += 1))}`, city: 'Nairobi', payment_type: 'prepaid',
    items: [{ product_id: product.id, quantity: 1 }],
  });
  expect(res.status).toBe(201);
  db.prepare('UPDATE orders SET delivery_fee = ? WHERE id = ?').run(FEE, res.body.data.id);
  const set = await request(app).post(`/api/orders/${res.body.data.id}/courier`).set(auth(adminToken)).send({ courier_id: courierId });
  expect(set.status).toBe(200);
  return res.body.data;
}

const dispatch = (id, body) => request(app).post(`/api/orders/${id}/dispatch`).set(auth(adminToken)).send(body);
const settlement = async (id) => (await request(app).get(`/api/orders/${id}/delivery`).set(auth(adminToken))).body.data;
const addCost = (id, body, who = cashier) => request(app).post(`/api/orders/${id}/delivery/costs`).set(auth(who.token))
  .send({ kind: 'outpost_leg', amount: 8000, reason: 'Outpost to Kitale rider', paid_via: 'mobile_money', ...body });
const approve = (costId, who = manager) => request(app).post(`/api/delivery/costs/${costId}/approve`).set(auth(who.token));
// A fee payment must be confirmed as real money before its settlement can close.
async function verifyReceipts(orderId, who = manager) {
  for (const r of db.prepare('SELECT id FROM delivery_fee_receipts WHERE order_id = ?').all(orderId)) {
    const res = await request(app).post(`/api/delivery/fee-receipts/${r.id}/verify`).set(auth(who.token)).send({ note: 'Seen on the deposit slip' });
    expect([201, 409]).toContain(res.status);
  }
}

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  cashier = await makeUser('cashier', 'settle-cashier@urbantrends.com');
  manager = await makeUser('manager', 'settle-manager@urbantrends.com');
  product = (await request(app).get('/api/products?pageSize=1').set(auth(adminToken))).body.data[0];
  db.prepare('UPDATE inventory SET quantity = 1000 WHERE product_id = ?').run(product.id);
  rider = (await request(app).post('/api/couriers').set(auth(adminToken)).send({ name: 'Settle Rider', courier_type: 'boda' })).body.data;
  org = (await request(app).post('/api/couriers').set(auth(adminToken)).send({ name: 'Settle Express', kind: 'organization', collects_payment: true })).body.data;
});
afterAll(() => cleanupTestDb());

describe('the delivery fee question at dispatch', () => {
  it('refuses to dispatch until it is answered, and changes nothing', async () => {
    const order = await makeOrder();
    const res = await dispatch(order.id, {});
    expect(res.status).toBe(422);
    expect(res.body.code || res.body.error?.code).toBeDefined();
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status).toBe('awaiting_dispatch');
    expect(db.prepare('SELECT COUNT(*) AS n FROM delivery_settlements WHERE order_id = ?').get(order.id).n).toBe(0);
  });

  it('refuses a collected amount above the fee charged, or without a payment method', async () => {
    const order = await makeOrder();
    expect((await dispatch(order.id, { delivery_fee_paid: true, delivery_fee_collected: FEE + 1, delivery_fee_method: 'cash' })).status).toBe(422);
    expect((await dispatch(order.id, { delivery_fee_paid: true, delivery_fee_collected: 100 })).status).toBe(422);
    expect((await dispatch(order.id, { delivery_fee_paid: false, delivery_fee_collected: 100 })).status).toBe(422);
    expect(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status).toBe('awaiting_dispatch');
  });

  it('records what the customer paid and opens the settlement', async () => {
    const order = await makeOrder();
    const res = await dispatch(order.id, { package_fee: 10000, delivery_fee_paid: true, delivery_fee_collected: 20000, delivery_fee_method: 'mobile_money', delivery_fee_reference: 'QWE123' });
    expect(res.status).toBe(200);
    const s = await settlement(order.id);
    expect(s.settlement.status).toBe('open');
    expect(s).toMatchObject({ fee_charged: FEE, fee_collected: 20000, fee_uncollected: 10000, package_fee: 10000, costs_total: 10000, result: 10000 });
    expect(s.fee_receipts).toHaveLength(1);
  });

  it('a customer who refused to pay leaves the whole cost with the shop', async () => {
    const order = await makeOrder();
    await dispatch(order.id, { package_fee: 10000, delivery_fee_paid: false });
    const s = await settlement(order.id);
    expect(s).toMatchObject({ fee_collected: 0, costs_total: 10000, result: -10000 });
  });
});

describe('extra costs', () => {
  it('needs a reason, counts only once someone else approves, and cannot be self-approved', async () => {
    const order = await makeOrder();
    await dispatch(order.id, { package_fee: 10000, delivery_fee_paid: true, delivery_fee_collected: FEE, delivery_fee_method: 'cash' });

    expect((await addCost(order.id, { reason: '   ' })).status).toBe(400);
    const rec = await addCost(order.id, { amount: 8000 });
    expect(rec.status).toBe(201);
    expect(rec.body.data.status).toBe('pending');

    let s = await settlement(order.id);
    expect(s.extra_costs).toBe(0);
    expect(s.pending_count).toBe(1);

    expect((await approve(rec.body.data.id, cashier)).status).toBe(403); // the person who entered it
    expect((await approve(rec.body.data.id)).status).toBe(200);
    s = await settlement(order.id);
    expect(s).toMatchObject({ extra_costs: 8000, costs_total: 18000, result: FEE - 18000 });
  });

  it('a rejected cost never counts', async () => {
    const order = await makeOrder();
    await dispatch(order.id, { delivery_fee_paid: false });
    const rec = await addCost(order.id, { amount: 5000 });
    const no = await request(app).post(`/api/delivery/costs/${rec.body.data.id}/reject`).set(auth(manager.token)).send({ reason: 'No receipt' });
    expect(no.status).toBe(200);
    expect((await settlement(order.id)).extra_costs).toBe(0);
  });

  it('works for a courier-organization delivery too (outpost leg)', async () => {
    const order = await makeOrder(org.id);
    const res = await dispatch(order.id, { package_fee: 25000, delivery_fee_paid: true, delivery_fee_collected: FEE, delivery_fee_method: 'cash' });
    expect(res.status).toBe(200);
    const rec = await addCost(order.id, { amount: 12000, reason: 'Kisumu outpost to Busia' });
    await approve(rec.body.data.id);
    expect(await settlement(order.id)).toMatchObject({ package_fee: 25000, extra_costs: 12000, costs_total: 37000, result: FEE - 37000 });
  });

  it('cannot be edited or deleted underneath the ledger', async () => {
    const order = await makeOrder();
    await dispatch(order.id, { delivery_fee_paid: false });
    const rec = await addCost(order.id, { amount: 5000 });
    expect(() => db.prepare('UPDATE delivery_costs SET amount = 1 WHERE id = ?').run(rec.body.data.id)).toThrow();
    expect(() => db.prepare('DELETE FROM delivery_costs WHERE id = ?').run(rec.body.data.id)).toThrow();
    expect(() => db.prepare('UPDATE delivery_fee_receipts SET amount = 1').run()).toThrow();
  });

  it('is refused before the order has been dispatched', async () => {
    const order = await makeOrder();
    expect((await addCost(order.id)).status).toBe(409);
  });
});

describe('corrections by reversal', () => {
  it('takes back part of an approved cost with its own reason and approval, never beyond the cost', async () => {
    const order = await makeOrder();
    await dispatch(order.id, { delivery_fee_paid: false });
    const rec = await addCost(order.id, { amount: 10000 });
    await approve(rec.body.data.id);

    const rev = await request(app).post(`/api/delivery/costs/${rec.body.data.id}/reverse`).set(auth(cashier.token)).send({ amount: 4000, reason: 'Entered twice' });
    expect(rev.status).toBe(201);
    expect((await settlement(order.id)).extra_costs).toBe(10000); // not until approved
    await approve(rev.body.data.id);
    expect((await settlement(order.id)).extra_costs).toBe(6000);

    const tooMuch = await request(app).post(`/api/delivery/costs/${rec.body.data.id}/reverse`).set(auth(cashier.token)).send({ amount: 6001, reason: 'Oops' });
    expect(tooMuch.status).toBe(409);
    const noReason = await request(app).post(`/api/delivery/costs/${rec.body.data.id}/reverse`).set(auth(cashier.token)).send({ amount: 100, reason: ' ' });
    expect(noReason.status).toBe(400);
  });
});

describe('fee paid later', () => {
  it('adds to what was collected but never past the fee charged', async () => {
    const order = await makeOrder();
    await dispatch(order.id, { delivery_fee_paid: true, delivery_fee_collected: 10000, delivery_fee_method: 'cash' });
    const more = await request(app).post(`/api/orders/${order.id}/delivery/fee-receipts`).set(auth(cashier.token)).send({ amount: 15000, method: 'mobile_money', reference: 'LATE1' });
    expect(more.status).toBe(201);
    expect(more.body.data.fee_collected).toBe(25000);
    const over = await request(app).post(`/api/orders/${order.id}/delivery/fee-receipts`).set(auth(cashier.token)).send({ amount: 5001, method: 'cash' });
    expect(over.status).toBe(409);
  });
});

describe('staying open until delivery is confirmed', () => {
  it('cannot close with a cost still waiting, then freezes the figures and locks the settlement', async () => {
    const order = await makeOrder();
    await dispatch(order.id, { package_fee: 10000, delivery_fee_paid: true, delivery_fee_collected: FEE, delivery_fee_method: 'cash' });
    const rec = await addCost(order.id, { amount: 5000 });

    const early = await request(app).post(`/api/orders/${order.id}/delivery/close`).set(auth(manager.token)).send({});
    expect(early.status).toBe(409);
    await approve(rec.body.data.id);
    const unverified = await request(app).post(`/api/orders/${order.id}/delivery/close`).set(auth(manager.token)).send({});
    expect(unverified.status).toBe(409);
    expect(unverified.body.error.code).toBe('FEES_UNVERIFIED');
    await verifyReceipts(order.id);

    expect((await request(app).post(`/api/orders/${order.id}/delivery/close`).set(auth(cashier.token)).send({})).status).toBe(403);
    const closed = await request(app).post(`/api/orders/${order.id}/delivery/close`).set(auth(manager.token)).send({ note: 'Customer confirmed by phone' });
    expect(closed.status).toBe(200);
    expect(closed.body.data.settlement).toMatchObject({ status: 'closed', outcome: 'delivered', fee_collected: FEE, costs_total: 15000, result: FEE - 15000 });

    expect((await addCost(order.id)).status).toBe(409);
    const late = await request(app).post(`/api/orders/${order.id}/delivery/fee-receipts`).set(auth(cashier.token)).send({ amount: 100, method: 'cash' });
    expect(late.status).toBe(409);
    const riderCost = await request(app).post(`/api/couriers/${rider.id}/costs`).set(auth(cashier.token)).send({ kind: 'fuel', amount: 100, description: 'late fuel', order_id: order.id });
    expect(riderCost.status).toBe(409);
  });

  it('only an administrator can reopen, and only with a reason', async () => {
    const order = await makeOrder();
    await dispatch(order.id, { delivery_fee_paid: false });
    await request(app).post(`/api/orders/${order.id}/delivery/close`).set(auth(manager.token)).send({ write_off_reason: 'Customer refused to pay the fee' });
    expect((await request(app).post(`/api/orders/${order.id}/delivery/reopen`).set(auth(manager.token)).send({ reason: 'late cost' })).status).toBe(403);
    expect((await request(app).post(`/api/orders/${order.id}/delivery/reopen`).set(auth(adminToken)).send({ reason: ' ' })).status).toBe(400);
    const ok = await request(app).post(`/api/orders/${order.id}/delivery/reopen`).set(auth(adminToken)).send({ reason: 'Outpost invoice arrived late' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.settlement.status).toBe('open');
  });

  it('a returned parcel closes as returned and its costs stay with the shop', async () => {
    const order = await makeOrder();
    await dispatch(order.id, { package_fee: 10000, delivery_fee_paid: false });
    await request(app).post(`/api/orders/${order.id}/returned-in-transit`).set(auth(adminToken)).send({});
    const tooSoon = await request(app).post(`/api/orders/${order.id}/delivery/close`).set(auth(manager.token)).send({});
    expect(tooSoon.status).toBe(409);
    await request(app).post(`/api/orders/${order.id}/returned-awaiting-inspection`).set(auth(adminToken)).send({});
    const closed = await request(app).post(`/api/orders/${order.id}/delivery/close`).set(auth(manager.token)).send({ write_off_reason: 'Parcel came back; fee never paid' });
    expect(closed.status).toBe(200);
    expect(closed.body.data.settlement).toMatchObject({ outcome: 'returned', result: -10000 });
  });
});

describe('settlements report', () => {
  it('lists deliveries with totals and can show only the ones that lost money', async () => {
    const res = await request(app).get('/api/delivery/settlements').set(auth(manager.token));
    expect(res.status).toBe(200);
    expect(res.body.totals.deliveries).toBe(res.body.rows.length);
    expect(res.body.totals.result).toBe(res.body.rows.reduce((t, r) => t + r.result, 0));
    const losses = await request(app).get('/api/delivery/settlements?loss_only=1').set(auth(manager.token));
    expect(losses.body.rows.every((r) => r.result < 0)).toBe(true);
    expect((await request(app).get('/api/delivery/settlements').set(auth(cashier.token))).status).toBe(403);
  });
});

describe('profit and loss', () => {
  const pnl = () => {
    const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
    const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    return profitLoss({ storeId: store.id, from: day(-20), to: day(20) });
  };

  it('counts fees collected as earnings and every approved delivery cost as cost, each once', async () => {
    const before = pnl();
    const order = await makeOrder();
    await dispatch(order.id, { package_fee: 10000, delivery_fee_paid: true, delivery_fee_collected: FEE, delivery_fee_method: 'cash' });
    const rec = await addCost(order.id, { amount: 5000 });
    expect(pnl().deliveryFees - before.deliveryFees).toBe(10000 - FEE); // the pending cost does not count yet
    await approve(rec.body.data.id);

    const after = pnl();
    expect(after.deliveryEarned - before.deliveryEarned).toBe(FEE);
    expect(after.deliveryCost - before.deliveryCost).toBe(15000);
    expect(after.deliveryFees - before.deliveryFees).toBe(15000 - FEE);
    expect(after.netProfit - before.netProfit).toBe(FEE - 15000); // extra earned: the delivery made money
    expect(after.netProfit).toBe(after.revenue - after.costOfGoodsSold - after.deliveryFees - after.businessExpenses);
  });

  it('a customer who does not pay the fee makes the delivery a plain cost', async () => {
    const before = pnl();
    const order = await makeOrder();
    await dispatch(order.id, { package_fee: 10000, delivery_fee_paid: false });
    expect(pnl().netProfit - before.netProfit).toBe(-10000);
  });

  it('paying the rider does not charge the same cost a second time', async () => {
    const order = await makeOrder();
    await dispatch(order.id, { package_fee: 10000, delivery_fee_paid: false });
    const before = pnl();
    const pay = await request(app).post(`/api/couriers/${rider.id}/payouts`).set(auth(manager.token)).send({ method: 'cash' });
    expect(pay.status).toBe(201);
    const after = pnl();
    expect(after.businessExpenses).toBe(before.businessExpenses);
    expect(after.deliveryFees).toBe(before.deliveryFees);
    expect(after.netProfit).toBe(before.netProfit);
  });
});
