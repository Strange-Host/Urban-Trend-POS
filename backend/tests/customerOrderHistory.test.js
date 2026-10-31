const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

let token;
let storeBToken;
let product;
let customerId;
const PHONE = '0711900100';

const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function placeOrder(name, phone, qty = 1) {
  const res = await request(app).post('/api/orders').set(auth(token))
    .send({ name, phone, items: [{ product_id: product.id, quantity: qty }] });
  expect(res.status).toBe(201);
  return res.body.data;
}

beforeAll(async () => {
  token = await loginAsAdmin();
  product = (await request(app).get('/api/products?pageSize=1').set(auth(token))).body.data[0];

  const storeB = db.prepare(`INSERT INTO stores (name) VALUES ('History Store B')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'B Admin', 'history-b@urbantrends.com', ?, 'admin', 1)`)
    .run(storeB, bcrypt.hashSync('Cobalt-Willow-9152', 10));
  storeBToken = (await request(app).post('/api/auth/login').send({ email: 'history-b@urbantrends.com', password: 'Cobalt-Willow-9152' })).body.token;

  // Three orders for one customer: one cancelled (so the phone is free again), one still open, plus a second customer.
  const first = await placeOrder('History Customer', PHONE);
  customerId = first.customer.id;
  expect((await request(app).post(`/api/orders/${first.id}/cancel`).set(auth(token)).send({})).status).toBe(200);
  await placeOrder('History Customer', PHONE, 2);
  await placeOrder('Someone Else', '0711900200');
});

afterAll(() => cleanupTestDb());

describe('customer order history', () => {
  it("lists a customer's orders newest first, by id", async () => {
    const res = await request(app).get(`/api/customers/${customerId}/orders`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.customer).toMatchObject({ id: customerId, name: 'History Customer', phone: PHONE });
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].id).toBeGreaterThan(res.body.data[1].id);
    expect(res.body.data[0]).toMatchObject({ status: 'awaiting_dispatch', item_count: 1 });
    expect(res.body.data.map((o) => o.status)).toContain('cancelled');
  });

  it('does not include another customer\'s orders', async () => {
    const res = await request(app).get(`/api/customers/${customerId}/orders`).set(auth(token));
    const owners = res.body.data.map((o) => db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(o.id).customer_id);
    expect(owners.every((id) => id === customerId)).toBe(true);
  });

  it('finds the same customer by phone in any common format', async () => {
    for (const phone of ['0711900100', '+254711900100', '254 711 900 100']) {
      const res = await request(app).get('/api/customers/orders').query({ phone }).set(auth(token));
      expect(res.status).toBe(200);
      expect(res.body.customer.id).toBe(customerId);
      expect(res.body.total).toBe(2);
    }
  });

  it('totals cover every order and leave out cancelled ones', async () => {
    const res = await request(app).get(`/api/customers/${customerId}/orders?limit=1`).set(auth(token));
    expect(res.body.data).toHaveLength(1); // one per page...
    const s = res.body.summary;
    expect(s.orders).toBe(2); // ...but the summary still covers both
    expect(s.cancelled).toBe(1);
    const open = db.prepare(`SELECT total, amount_paid FROM orders WHERE customer_id = ? AND status != 'cancelled'`).all(customerId);
    expect(s.total_ordered).toBe(open.reduce((n, o) => n + o.total, 0));
    expect(s.outstanding).toBe(open.reduce((n, o) => n + o.total - o.amount_paid, 0));
    expect(s.first_order_at).toBeTruthy();
    expect(s.last_order_at).toBeTruthy();
  });

  it('pages through the history', async () => {
    const p1 = await request(app).get(`/api/customers/${customerId}/orders?limit=1&page=1`).set(auth(token));
    const p2 = await request(app).get(`/api/customers/${customerId}/orders?limit=1&page=2`).set(auth(token));
    expect(p1.body.data[0].id).not.toBe(p2.body.data[0].id);
    expect(p2.body.total).toBe(2);
  });

  it('is 404 for an unknown customer, a bad id, or a phone with no orders', async () => {
    expect((await request(app).get('/api/customers/999999/orders').set(auth(token))).status).toBe(404);
    expect((await request(app).get('/api/customers/abc/orders').set(auth(token))).status).toBe(404);
    expect((await request(app).get('/api/customers/orders').query({ phone: '0799000000' }).set(auth(token))).status).toBe(404);
  });

  it('asks for an id or a phone', async () => {
    expect((await request(app).get('/api/customers/orders').set(auth(token))).status).toBe(400);
  });

  it('is invisible to another shop, by id and by phone', async () => {
    expect((await request(app).get(`/api/customers/${customerId}/orders`).set(auth(storeBToken))).status).toBe(404);
    expect((await request(app).get('/api/customers/orders').query({ phone: PHONE }).set(auth(storeBToken))).status).toBe(404);
  });

  it('needs a login', async () => {
    expect((await request(app).get(`/api/customers/${customerId}/orders`)).status).toBe(401);
  });
});
