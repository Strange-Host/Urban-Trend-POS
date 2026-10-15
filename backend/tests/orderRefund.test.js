const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

afterAll(() => cleanupTestDb());

const auth = (t) => ({ Authorization: `Bearer ${t}` });
let token;
let n = 0;
beforeAll(async () => { token = await loginAsAdmin(); });

// A dispatched order worth 10000 (2 x 5000), nothing paid yet.
async function dispatchedOrder() {
  n += 1;
  const pid = db.prepare(`INSERT INTO products (sku, name, cost_price, sell_price, is_active) VALUES (?, 'Refund Test', 3000, 5000, 1)`)
    .run(`REF-${n}-${Date.now()}`).lastInsertRowid;
  db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, 1, 50)').run(pid);
  const created = await request(app).post('/api/orders').set(auth(token))
    .send({ payment_type: 'prepaid', name: 'Refund Customer', phone: `07660000${String(n).padStart(2, '0')}`, items: [{ product_id: pid, quantity: 2 }] });
  expect(created.status).toBe(201);
  const id = created.body.data.id;
  expect((await request(app).post(`/api/orders/${id}/dispatch`).set(auth(token))).status).toBe(200);
  return { id, total: created.body.data.total };
}
const pay = (id, amount) => request(app).post(`/api/orders/${id}/payments`).set(auth(token)).send({ method: 'mobile_money', amount, reference: `R${Date.now()}${Math.random()}` });
const order = (id) => db.prepare('SELECT status, amount_paid FROM orders WHERE id = ?').get(id);
const paymentIds = (id) => db.prepare(`SELECT id FROM payment_records WHERE order_id = ? ORDER BY id`).all(id).map((r) => r.id);
const refund = (paymentId) => request(app).post(`/api/payments/${paymentId}/refund`).set(auth(token));

describe('refunding an order payment', () => {
  it('takes the money off the order and moves it back to part paid, then unpaid', async () => {
    const { id, total } = await dispatchedOrder();
    expect((await pay(id, 4000)).status).toBe(201);
    expect((await pay(id, total - 4000)).status).toBe(201);
    expect(order(id)).toEqual({ status: 'dispatched_paid', amount_paid: total });
    const [first, second] = paymentIds(id);

    expect((await refund(second)).status).toBe(200);
    // before the fix: still dispatched_paid with the full amount_paid
    expect(order(id)).toEqual({ status: 'dispatched_partial', amount_paid: 4000 });

    expect((await refund(first)).status).toBe(200);
    expect(order(id)).toEqual({ status: 'dispatched_unpaid', amount_paid: 0 });

    const history = db.prepare('SELECT from_status, to_status FROM order_status_history WHERE order_id = ? ORDER BY id DESC LIMIT 2').all(id);
    expect(history).toEqual([
      { from_status: 'dispatched_partial', to_status: 'dispatched_unpaid' },
      { from_status: 'dispatched_paid', to_status: 'dispatched_partial' },
    ]);

    // the customer can pay again afterwards
    expect((await pay(id, total)).status).toBe(201);
    expect(order(id)).toEqual({ status: 'dispatched_paid', amount_paid: total });
  });

  it('cannot refund the same payment twice (no double deduction)', async () => {
    const { id, total } = await dispatchedOrder();
    await pay(id, total);
    const [p] = paymentIds(id);
    expect((await refund(p)).status).toBe(200);
    expect((await refund(p)).status).toBe(409);
    expect(order(id).amount_paid).toBe(0);
  });

  it('keeps the order status when the parcel has already come back, but still reduces amount_paid', async () => {
    const { id, total } = await dispatchedOrder();
    await pay(id, total);
    db.prepare(`UPDATE orders SET status = 'returned_in_transit' WHERE id = ?`).run(id);
    const [p] = paymentIds(id);
    expect((await refund(p)).status).toBe(200);
    expect(order(id)).toEqual({ status: 'returned_in_transit', amount_paid: 0 });
  });

  it('refunds that are not tied to an order work as before', async () => {
    const made = await request(app).post('/api/payments').set(auth(token))
      .send({ direction: 'outgoing', supplier_name: 'Some Supplier', method: 'bank_transfer', amount: 5000 });
    expect(made.status).toBe(201);
    const res = await refund(made.body.data.id);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('refunded');
  });

  it('the dashboard stops counting a refunded online payment as sold', async () => {
    const { id, total } = await dispatchedOrder();
    await pay(id, total);
    const { localDate } = require('../src/utils/storeTime');
    const today = localDate();
    const before = (await request(app).get(`/api/reports/dashboard-overview?date=${today}`).set(auth(token))).body.data.salesToday.onlineRevenue;
    await refund(paymentIds(id)[0]);
    const after = (await request(app).get(`/api/reports/dashboard-overview?date=${today}`).set(auth(token))).body.data.salesToday.onlineRevenue;
    expect(before - after).toBe(total);
  });
});
