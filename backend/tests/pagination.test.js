const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

let a; let product; let storeId; let adminId;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const get = (url) => request(app).get(url).set(a);

beforeAll(async () => {
  a = auth(await loginAsAdmin());
  product = (await get('/api/products?pageSize=1')).body.data[0];
  const admin = db.prepare("SELECT id, store_id FROM users WHERE email = 'admin@urbantrends.com'").get();
  storeId = admin.store_id; adminId = admin.id;
});
afterAll(() => cleanupTestDb());

// 60 orders, so 25-per-page really is 3 pages
async function seedOrders(n) {
  for (let i = 0; i < n; i++) {
    const res = await request(app).post('/api/orders').set(a).send({ name: `Buyer ${i}`, phone: `07${String(10000000 + i)}`, payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] });
    expect(res.status).toBe(201);
  }
}

describe('orders list pages through EVERYTHING', () => {
  it('every order is reachable, none repeated, none skipped, across pages', async () => {
    await seedOrders(60);
    const first = (await get('/api/orders?page=1&limit=25')).body;
    expect(first).toMatchObject({ total: 60, page: 1, totalPages: 3 });
    expect(first.data).toHaveLength(25);
    const seen = new Set(first.data.map((o) => o.id));
    for (const page of [2, 3]) {
      const body = (await get(`/api/orders?page=${page}&limit=25`)).body;
      for (const o of body.data) { expect(seen.has(o.id)).toBe(false); seen.add(o.id); }
    }
    expect(seen.size).toBe(60);
    const lastPage = (await get('/api/orders?page=3&limit=25')).body;
    expect(lastPage.data).toHaveLength(10);
    expect((await get('/api/orders?page=4&limit=25')).body.data).toHaveLength(0);   // past the end: empty, not an error
  });

  it('the page size is capped at 100, so a client asking for more silently gets 100 - which is why pickers must page', async () => {
    expect((await get('/api/orders?limit=500')).body.data).toHaveLength(60);        // only 60 exist
    const products = (await get('/api/products?pageSize=1000')).body;
    expect(products.data.length).toBeLessThanOrEqual(100);
  });

  it('"outstanding" is the total across ALL matching orders, not the 25 on screen', async () => {
    const all = db.prepare("SELECT SUM(total - amount_paid) v FROM orders WHERE status != 'cancelled'").get().v;
    const page1 = (await get('/api/orders?page=1&limit=25')).body;
    expect(page1.summary.outstanding).toBe(all);
    const onScreen = page1.data.reduce((n, o) => n + (o.total - o.amount_paid), 0);
    expect(onScreen).toBeLessThan(all);                                              // proves the old on-screen sum under-reported
    expect((await get('/api/orders?page=3&limit=25')).body.summary.outstanding).toBe(all);   // same on every page
  });

  it('filters and pagination combine: the total reflects the filter', async () => {
    await request(app).post(`/api/orders/${(await get('/api/orders?page=1&limit=1')).body.data[0].id}/dispatch`).set(a);
    const filtered = (await get('/api/orders?status=awaiting_dispatch&limit=25')).body;
    expect(filtered.total).toBe(59);
    expect(filtered.totalPages).toBe(3);
  });
});

describe('every paged endpoint answers page/limit consistently', () => {
  it('returns { data, total, page, totalPages } so one Pager works everywhere', async () => {
    const endpoints = ['/api/orders', '/api/leads', '/api/staff', '/api/expenses', '/api/payments', '/api/requisitions',
      '/api/staff-logs', '/api/payment-reconciliation/unmatched', '/api/sales', '/api/cash-sessions', '/api/products', '/api/notifications'];
    for (const url of endpoints) {
      const res = await get(`${url}?page=1&limit=5&pageSize=5`);
      expect(res.status, url).toBe(200);
      expect(Array.isArray(res.body.data), url).toBe(true);
      expect(typeof res.body.total, url).toBe('number');
      expect(typeof res.body.totalPages, url).toBe('number');
      expect(res.body.data.length, url).toBeLessThanOrEqual(5);
    }
  });

  it('reconciliation reports the unallocated total across all unmatched payments', async () => {
    const insert = db.prepare(`INSERT INTO payment_notifications (store_id, source, method, amount, status, raw_payload) VALUES (?, 'kcb', 'mobile_money', ?, 'unmatched', '{}')`);
    for (let i = 0; i < 30; i++) insert.run(storeId, 1000);
    const body = (await get('/api/payment-reconciliation/unmatched?limit=25')).body;
    expect(body.total).toBe(30);
    expect(body.data).toHaveLength(25);
    expect(body.summary.unallocated).toBe(30000);   // all 30, not the 25 shown
  });
});

describe('cash sessions list (it used to answer 500 for everyone)', () => {
  it('lists sessions for an admin, newest first, with the cashier name, and pages them', async () => {
    const u = (await get('/api/staff?limit=1')).body.data[0];
    const open = (n) => db.prepare("INSERT INTO cash_sessions (store_id, user_id, opening_amount, opened_at) VALUES (?, ?, 0, datetime('now', ?))").run(storeId, u.id, `-${n} hours`);
    for (let i = 1; i <= 7; i++) open(i);
    const res = await get('/api/cash-sessions?page=1&pageSize=5');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 7, page: 1, totalPages: 2 });
    expect(res.body.data).toHaveLength(5);
    expect(res.body.data[0].cashier_name).toBeTruthy();
    expect((await get('/api/cash-sessions?page=2&pageSize=5')).body.data).toHaveLength(2);
  });
});
