const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

let token;
let p1;
let p2;
let seq = 0;
const auth = () => ({ Authorization: `Bearer ${token}` });

const makeOrder = async (items, extra = {}) => {
  const res = await request(app).post('/api/orders').set(auth()).send({
    name: 'Edit Customer', phone: `07338${String(40000 + (seq += 1))}`, city: 'Nairobi', items, ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.data;
};
const getOrder = async (id) => (await request(app).get(`/api/orders/${id}`).set(auth())).body.data;
const putItems = (id, items) => request(app).put(`/api/orders/${id}/items`).set(auth()).send({ items });

beforeAll(async () => {
  token = await loginAsAdmin();
  const products = (await request(app).get('/api/products?pageSize=5').set(auth())).body.data;
  [p1, p2] = products;
  db.prepare('UPDATE inventory SET quantity = 1000').run();
});
afterAll(() => cleanupTestDb());

describe('changing the items of an order that has not been dispatched', () => {
  it('adds, changes and removes lines, and works the totals out again', async () => {
    const order = await makeOrder([{ product_id: p1.id, quantity: 1 }]);
    const res = await putItems(order.id, [{ product_id: p1.id, quantity: 3 }, { product_id: p2.id, quantity: 2 }]);
    expect(res.status).toBe(200);
    const expected = p1.sell_price * 3 + p2.sell_price * 2;
    expect(res.body.data.subtotal).toBe(expected);
    expect(res.body.data.total).toBe(expected);
    expect(res.body.data.items).toHaveLength(2);

    const removed = await putItems(order.id, [{ product_id: p2.id, quantity: 1 }]);
    expect(removed.body.data.items).toHaveLength(1);
    expect(removed.body.data.total).toBe(p2.sell_price);
  });

  it('keeps at least one item and lists each product once', async () => {
    const order = await makeOrder([{ product_id: p1.id, quantity: 1 }]);
    expect((await putItems(order.id, [])).status).toBe(400);
    expect((await putItems(order.id, [{ product_id: p1.id, quantity: 1 }, { product_id: p1.id, quantity: 2 }])).status).toBe(422);
  });

  it('is blocked entirely once the order has been dispatched', async () => {
    const order = await makeOrder([{ product_id: p1.id, quantity: 1 }], { payment_type: 'prepaid' });
    const d = await request(app).post(`/api/orders/${order.id}/dispatch`).set(auth()).send({ delivery_fee_paid: false });
    expect(d.status).toBe(200);
    const res = await putItems(order.id, [{ product_id: p1.id, quantity: 5 }]);
    expect(res.status).toBe(409);
    const merge = await request(app).post(`/api/orders/${order.id}/merge-items`).set(auth()).send({ items: [{ product_id: p1.id, quantity: 1 }] });
    expect(merge.status).toBe(409);
    expect((await getOrder(order.id)).total).toBe(p1.sell_price);
  });

  it('leaves orders imported from an online store alone', async () => {
    const order = await makeOrder([{ product_id: p1.id, quantity: 1 }]);
    db.prepare(`UPDATE orders SET channel = 'shopify' WHERE id = ?`).run(order.id);
    expect((await putItems(order.id, [{ product_id: p1.id, quantity: 2 }])).status).toBe(409);
  });

  it('withdraws a COD confirmation when the change moves the total', async () => {
    const order = await makeOrder([{ product_id: p1.id, quantity: 1 }]);
    expect((await request(app).post(`/api/orders/${order.id}/confirm-cod`).set(auth())).status).toBe(200);
    expect((await getOrder(order.id)).cod_confirmed_at).not.toBeNull();
    await putItems(order.id, [{ product_id: p1.id, quantity: 2 }]);
    expect((await getOrder(order.id)).cod_confirmed_at).toBeNull();
    const d = await request(app).post(`/api/orders/${order.id}/dispatch`).set(auth()).send({ delivery_fee_paid: false });
    expect(d.status).toBe(409); // must be confirmed again for the new basket
  });

  it('refuses a total below what has already been paid', async () => {
    const order = await makeOrder([{ product_id: p1.id, quantity: 2 }], { payment_type: 'prepaid' });
    db.prepare('UPDATE orders SET amount_paid = ? WHERE id = ?').run(p1.sell_price * 2, order.id);
    expect((await putItems(order.id, [{ product_id: p1.id, quantity: 1 }])).status).toBe(409);
  });
});

describe('one customer, several orders', () => {
  // The duplicate-phone rule stops a second manual order, so the second order is moved onto the same customer directly.
  async function twoOrdersForOneCustomer() {
    const a = await makeOrder([{ product_id: p1.id, quantity: 1 }]);
    const b = await makeOrder([{ product_id: p2.id, quantity: 2 }]);
    db.prepare('UPDATE orders SET customer_id = ? WHERE id = ?').run(a.customer_id, b.id);
    return { a, b };
  }

  it('shows that one customer has asked for several products', async () => {
    const { a, b } = await twoOrdersForOneCustomer();
    const res = await request(app).get(`/api/orders/merge-groups?order_id=${b.id}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].orders.map((o) => o.id)).toEqual([a.id, b.id]);
    expect(res.body.data[0].suggested_keep_order_id).toBe(a.id);
    expect(res.body.data[0].combined_subtotal).toBe(p1.sell_price + p2.sell_price * 2);
    const all = await request(app).get('/api/orders/merge-groups').set(auth());
    expect(all.body.data.some((g) => g.customer_id === a.customer_id)).toBe(true);
  });

  it('merges only with explicit permission', async () => {
    const { a, b } = await twoOrdersForOneCustomer();
    const noPerm = await request(app).post('/api/orders/merge').set(auth()).send({ keep_order_id: a.id, merge_order_ids: [b.id] });
    expect(noPerm.status).toBe(422);
    const declined = await request(app).post('/api/orders/merge').set(auth()).send({ keep_order_id: a.id, merge_order_ids: [b.id], confirm: false });
    expect(declined.status).toBe(422);
    expect((await getOrder(b.id)).status).toBe('awaiting_dispatch');
  });

  it('moves the items into one order, one delivery fee, and cancels the other with a pointer', async () => {
    const { a, b } = await twoOrdersForOneCustomer();
    const res = await request(app).post('/api/orders/merge').set(auth()).send({ keep_order_id: a.id, merge_order_ids: [b.id], confirm: true });
    expect(res.status).toBe(200);
    const kept = res.body.data;
    expect(kept.items).toHaveLength(2);
    expect(kept.total).toBe(p1.sell_price + p2.sell_price * 2);

    const gone = await getOrder(b.id);
    expect(gone).toMatchObject({ status: 'cancelled', total: 0, subtotal: 0, delivery_fee: 0, merged_into_order_id: a.id });
    expect(gone.items).toHaveLength(0);

    const integrity = await request(app).get('/api/orders/integrity').set(auth());
    expect(integrity.body.data.filter((m) => [a.id, b.id].includes(m.order_id ?? m.id))).toHaveLength(0);
  });

  it('refuses orders that are dispatched, paid on, or belong to someone else', async () => {
    const { a, b } = await twoOrdersForOneCustomer();
    db.prepare(`UPDATE orders SET status = 'dispatched_unpaid' WHERE id = ?`).run(b.id);
    const dispatched = await request(app).post('/api/orders/merge').set(auth()).send({ keep_order_id: a.id, merge_order_ids: [b.id], confirm: true });
    expect(dispatched.status).toBe(409);

    const c = await makeOrder([{ product_id: p1.id, quantity: 1 }]);
    const stranger = await request(app).post('/api/orders/merge').set(auth()).send({ keep_order_id: a.id, merge_order_ids: [c.id], confirm: true });
    expect(stranger.status).toBe(409);

    const d = await makeOrder([{ product_id: p1.id, quantity: 1 }]);
    db.prepare('UPDATE orders SET customer_id = ?, amount_paid = 100 WHERE id = ?').run(a.customer_id, d.id);
    const paid = await request(app).post('/api/orders/merge').set(auth()).send({ keep_order_id: a.id, merge_order_ids: [d.id], confirm: true });
    expect(paid.status).toBe(409);
  });
});
