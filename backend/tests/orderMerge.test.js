const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

let token;
let product;
const auth = () => ({ Authorization: `Bearer ${token}` });
let n = 0;
const nextPhone = () => `07550${String(10000 + n++)}`;

beforeAll(async () => {
  token = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=1').set(auth());
  product = res.body.data[0];
});
afterAll(() => cleanupTestDb());

const setting = (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

describe('merging items into an order', () => {
  it('adds the lines and raises subtotal and total together', async () => {
    const first = await request(app).post('/api/orders').set(auth())
      .send({ name: 'Merge A', phone: nextPhone(), items: [{ product_id: product.id, quantity: 1 }] });
    expect(first.status).toBe(201);
    const id = first.body.data.id;

    const res = await request(app).post(`/api/orders/${id}/merge-items`).set(auth())
      .send({ items: [{ product_id: product.id, quantity: 2 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.subtotal).toBe(product.sell_price * 3);
    expect(res.body.data.total).toBe(product.sell_price * 3);

    const full = await request(app).get(`/api/orders/${id}`).set(auth());
    expect(full.body.data.items).toHaveLength(2);
  });

  it('recomputes the delivery fee when the merge crosses the fee threshold', async () => {
    // Flat KES 300 below KES (price + 1), 10% at or above it: one unit sits under, two units sit over.
    setting('delivery_fee_threshold_kes', Math.floor(product.sell_price / 100) + 1);
    setting('delivery_fee_flat_kes', 300);
    setting('delivery_fee_percent', 10);

    const first = await request(app).post('/api/orders').set(auth())
      .send({ name: 'Merge Fee', phone: nextPhone(), items: [{ product_id: product.id, quantity: 1 }] });
    expect(first.status).toBe(201);
    expect(first.body.data.delivery_fee).toBe(30000);

    const res = await request(app).post(`/api/orders/${first.body.data.id}/merge-items`).set(auth())
      .send({ items: [{ product_id: product.id, quantity: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(product.sell_price * 2);
    expect(res.body.data.delivery_fee).toBe(Math.round(product.sell_price * 2 * 0.10));
  });

  it('refuses once the order has been dispatched', async () => {
    const first = await request(app).post('/api/orders').set(auth())
      .send({ name: 'Merge Late', phone: nextPhone(), items: [{ product_id: product.id, quantity: 1 }] });
    db.prepare(`UPDATE orders SET status = 'dispatched_unpaid' WHERE id = ?`).run(first.body.data.id);
    const res = await request(app).post(`/api/orders/${first.body.data.id}/merge-items`).set(auth())
      .send({ items: [{ product_id: product.id, quantity: 1 }] });
    expect(res.status).toBe(409);
  });
});
