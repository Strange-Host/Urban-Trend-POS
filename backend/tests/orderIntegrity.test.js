const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const { findOrderLineMismatches } = require('../src/services/reconciliation.service');

let adminToken;
let cashierToken;
let product;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let n = 0;
const nextPhone = () => `07660${String(10000 + n++)}`;

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'Integrity Cashier', ?, ?, 'cashier', 1)`)
    .run(store.id, 'integrity-cashier@urbantrends.com', bcrypt.hashSync('Passw0rd!Passw0rd', 10));
  const login = await request(app).post('/api/auth/login').send({ email: 'integrity-cashier@urbantrends.com', password: 'Passw0rd!Passw0rd' });
  cashierToken = login.body.token;
  product = (await request(app).get('/api/products?pageSize=1').set(auth(adminToken))).body.data[0];
});
afterAll(() => cleanupTestDb());

async function makeOrder(extra = {}) {
  const res = await request(app).post('/api/orders').set(auth(adminToken))
    .send({ name: 'Integrity', phone: nextPhone(), items: [{ product_id: product.id, quantity: 2 }], ...extra });
  expect(res.status).toBe(201);
  return res.body.data;
}

describe('order integrity check', () => {
  it('reports nothing for orders made and merged through the normal paths', async () => {
    const order = await makeOrder();
    const merged = await request(app).post(`/api/orders/${order.id}/merge-items`).set(auth(adminToken))
      .send({ items: [{ product_id: product.id, quantity: 1 }] });
    expect(merged.status).toBe(200);

    const res = await request(app).get('/api/orders/integrity').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('flags an order whose subtotal no longer matches its lines', async () => {
    const order = await makeOrder();
    db.prepare('UPDATE orders SET subtotal = subtotal + 500, total = total + 500 WHERE id = ?').run(order.id);

    const res = await request(app).get('/api/orders/integrity').set(auth(adminToken));
    const hit = res.body.data.find((r) => r.order_id === order.id);
    expect(hit).toBeDefined();
    expect(hit.problems).toEqual(['lines_do_not_match_subtotal']);
    expect(hit.subtotal - hit.lines_total).toBe(500);
    expect(hit.product_code).toBe(order.product_code);
  });

  it('flags an order whose total is not subtotal minus discount', async () => {
    const order = await makeOrder();
    db.prepare('UPDATE orders SET total = total - 100 WHERE id = ?').run(order.id);

    const hit = findOrderLineMismatches().find((r) => r.order_id === order.id);
    expect(hit.problems).toEqual(['total_does_not_match_subtotal_less_discount']);
    expect(hit.expected_total - hit.total).toBe(100);
  });

  it('flags an order whose lines were removed entirely', async () => {
    const order = await makeOrder();
    db.prepare('DELETE FROM order_items WHERE order_id = ?').run(order.id);
    const hit = findOrderLineMismatches().find((r) => r.order_id === order.id);
    expect(hit.lines_total).toBe(0);
    expect(hit.problems).toContain('lines_do_not_match_subtotal');
  });

  it('ignores soft-deleted orders and never changes any data', async () => {
    const order = await makeOrder();
    db.prepare('UPDATE orders SET subtotal = subtotal + 1, total = total + 1 WHERE id = ?').run(order.id);
    const before = db.prepare('SELECT subtotal, total FROM orders WHERE id = ?').get(order.id);

    expect(findOrderLineMismatches().some((r) => r.order_id === order.id)).toBe(true);
    db.prepare(`UPDATE orders SET deleted_at = datetime('now') WHERE id = ?`).run(order.id);
    expect(findOrderLineMismatches().some((r) => r.order_id === order.id)).toBe(false);

    const after = db.prepare('SELECT subtotal, total FROM orders WHERE id = ?').get(order.id);
    expect(after).toEqual(before); // detect-only
  });

  it('is limited to admins and managers', async () => {
    const res = await request(app).get('/api/orders/integrity').set(auth(cashierToken));
    expect(res.status).toBe(403);
  });
});
