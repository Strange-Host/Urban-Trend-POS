const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

// The two read-only additions behind the redesigned till and cashier Start screen:
// the caller's own discount limit, and what the open shift has taken so far.

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'Passw0rd!Passw0rd';
let adminToken; let cashier; let manager; let storekeeper; let product;

async function makeUser(role, email) {
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  const r = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(store.id, `${role} start`, email, bcrypt.hashSync(PASSWORD, 10), role);
  const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  return { id: r.lastInsertRowid, token: login.body.token };
}
const setSetting = (key, value) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  cashier = await makeUser('cashier', 'start-cashier@urbantrends.com');
  manager = await makeUser('manager', 'start-manager@urbantrends.com');
  storekeeper = await makeUser('store', 'start-store@urbantrends.com');
  product = db.prepare(`SELECT p.id, p.sell_price FROM products p WHERE p.is_active = 1 AND p.approval_status = 'approved' LIMIT 1`).get();
  const storeId = db.prepare('SELECT store_id FROM users WHERE id = ?').get(cashier.id).store_id;
  db.prepare('UPDATE inventory SET quantity = quantity + 50 WHERE product_id = ? AND store_id = ?').run(product.id, storeId);
});
afterAll(() => cleanupTestDb());

describe('GET /api/sales/discount-limit', () => {
  it('is 0 (no limit) while the setting is off', async () => {
    setSetting('max_discount_percent', '0');
    const res = await request(app).get('/api/sales/discount-limit').set(auth(cashier.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ maxPercent: 0 });
  });

  it('gives a cashier the configured percent, and the same number checkout enforces', async () => {
    setSetting('max_discount_percent', '10');
    const res = await request(app).get('/api/sales/discount-limit').set(auth(cashier.token));
    expect(res.body.data).toEqual({ maxPercent: 10 });
    const over = Math.floor(product.sell_price * 0.11);
    const refused = await request(app).post('/api/sales').set(auth(cashier.token)).send({
      items: [{ product_id: product.id, quantity: 1 }],
      discountTotal: over,
      payments: [{ method: 'cash', amount: product.sell_price - over }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/above the 10% limit/i);
    setSetting('max_discount_percent', '0');
  });

  it('is 0 for a manager and an admin, who are not held to the limit', async () => {
    setSetting('max_discount_percent', '10');
    for (const token of [manager.token, adminToken]) {
      const res = await request(app).get('/api/sales/discount-limit').set(auth(token));
      expect(res.body.data).toEqual({ maxPercent: 0 });
    }
    setSetting('max_discount_percent', '0');
  });

  it('is closed to the storekeeper and to anyone not signed in', async () => {
    expect((await request(app).get('/api/sales/discount-limit').set(auth(storekeeper.token))).status).toBe(403);
    expect((await request(app).get('/api/sales/discount-limit')).status).toBe(401);
  });
});

describe('GET /api/cash-sessions/current: sales so far', () => {
  it('is null with no open shift', async () => {
    const res = await request(app).get('/api/cash-sessions/current').set(auth(cashier.token));
    expect(res.body.data).toBeNull();
  });

  it('returns the open session with the count and total of its non-voided sales', async () => {
    const open = await request(app).post('/api/cash-sessions/open').set(auth(cashier.token)).send({ openingAmount: 5000 });
    expect(open.status).toBe(201);

    let res = await request(app).get('/api/cash-sessions/current').set(auth(cashier.token));
    expect(res.body.data).toMatchObject({ id: open.body.data.id, opening_amount: 5000, sales_count: 0, sales_total: 0 });

    const ring = () => request(app).post('/api/sales').set(auth(cashier.token)).send({
      items: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'cash', amount: product.sell_price }],
    });
    const a = await ring();
    const b = await ring();
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    res = await request(app).get('/api/cash-sessions/current').set(auth(cashier.token));
    expect(res.body.data).toMatchObject({ sales_count: 2, sales_total: product.sell_price * 2 });

    db.prepare(`UPDATE sales SET status = 'voided' WHERE id = ?`).run(b.body.data.id);
    res = await request(app).get('/api/cash-sessions/current').set(auth(cashier.token));
    expect(res.body.data).toMatchObject({ sales_count: 1, sales_total: product.sell_price });
  });
});
