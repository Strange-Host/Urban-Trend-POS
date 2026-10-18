const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
// NOTE: must come AFTER ./setup — setup sets DATABASE_PATH to a temp file before config/db.js
// is first loaded. Requiring db first opened the real data/urban_trends.db and wrote test rows into it.
const db = require('../src/config/db');

let storeAToken;
let storeBToken;
let storeASaleId;
let storeACashSessionId;
let product;

beforeAll(async () => {
  storeAToken = await loginAsAdmin(); // seeded admin, store A

  // A second, entirely separate store + admin — created directly via the
  // DB rather than through an API, since this app has no public
  // "create store" endpoint (stores are provisioned via seed or the
  // Shopify/WooCommerce sync setup flow, not a normal signup path).
  const storeBResult = db.prepare(`INSERT INTO stores (name) VALUES ('Store B')`).run();
  const storeBId = storeBResult.lastInsertRowid;
  const passwordHash = bcrypt.hashSync('Cobalt-Willow-9152', 10);
  db.prepare(`
    INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'Store B Admin', 'storeb@urbantrends.com', ?, 'admin', 1)
  `).run(storeBId, passwordHash);

  const loginRes = await request(app).post('/api/auth/login').send({ email: 'storeb@urbantrends.com', password: 'Cobalt-Willow-9152' });
  storeBToken = loginRes.body.token;

  // A real sale + cash session in Store A, to try reaching from Store B.
  const productsRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${storeAToken}`);
  product = productsRes.body.data[0];

  const openRes = await request(app).post('/api/cash-sessions/open').set('Authorization', `Bearer ${storeAToken}`).send({ openingAmount: 5000 });
  storeACashSessionId = openRes.body.data.id;

  const checkoutRes = await request(app).post('/api/sales').set('Authorization', `Bearer ${storeAToken}`)
    .send({ items: [{ product_id: product.id, quantity: 1 }], payments: [{ method: 'cash', amount: product.sell_price }] });
  storeASaleId = checkoutRes.body.data.id;
});

afterAll(() => cleanupTestDb());

describe('cross-store authorization (Phase 1.6)', () => {
  it('1.1 — a sale from Store A is invisible to Store B (getById)', async () => {
    const res = await request(app).get(`/api/sales/${storeASaleId}`).set('Authorization', `Bearer ${storeBToken}`);
    expect(res.status).toBe(404);
  });

  it('1.1 — Store B cannot void Store A\'s sale', async () => {
    const res = await request(app).post(`/api/sales/${storeASaleId}/void`).set('Authorization', `Bearer ${storeBToken}`);
    expect(res.status).toBe(404);

    // And it's genuinely still there for Store A afterward — never touched.
    const stillThereRes = await request(app).get(`/api/sales/${storeASaleId}`).set('Authorization', `Bearer ${storeAToken}`);
    expect(stillThereRes.status).toBe(200);
    expect(stillThereRes.body.data.status).toBe('completed');
  });

  it('1.1 — Store A itself can still reach its own sale (no regression)', async () => {
    const res = await request(app).get(`/api/sales/${storeASaleId}`).set('Authorization', `Bearer ${storeAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(storeASaleId);
  });

  it('1.2 — Store B\'s sales list never includes Store A\'s sale, even with the old includeAllChannels flag', async () => {
    const res = await request(app).get('/api/sales?includeAllChannels=1').set('Authorization', `Bearer ${storeBToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((s) => s.id === storeASaleId)).toBe(false);
  });

  it('1.3 — a cash session from Store A is invisible to Store B', async () => {
    const res = await request(app).get(`/api/cash-sessions/${storeACashSessionId}`).set('Authorization', `Bearer ${storeBToken}`);
    expect(res.status).toBe(404);

    const ownRes = await request(app).get(`/api/cash-sessions/${storeACashSessionId}`).set('Authorization', `Bearer ${storeAToken}`);
    expect(ownRes.status).toBe(200);
  });

  it('1.4 — reports never surface Store A\'s data to Store B', async () => {
    const endpoints = ['sales-by-channel', 'sales-trend', 'payment-methods', 'top-products-by-channel'];
    for (const endpoint of endpoints) {
      const storeBRes = await request(app).get(`/api/reports/${endpoint}`).set('Authorization', `Bearer ${storeBToken}`);
      expect(storeBRes.status).toBe(200);
      // Store B has made zero sales — any nonzero revenue here would mean Store A's leaked in.
      const rows = Array.isArray(storeBRes.body.data) ? storeBRes.body.data : Object.values(storeBRes.body.data).flat();
      expect(rows.length === 0 || rows.every((r) => !r.revenue && !r.total_amount)).toBe(true);
    }

    // Store A, meanwhile, still sees its own sale reflected.
    const storeARes = await request(app).get('/api/reports/sales-by-channel').set('Authorization', `Bearer ${storeAToken}`);
    expect(storeARes.body.data.some((r) => r.revenue > 0)).toBe(true);
  });

  it('1.5 — Store B cannot attach a payment to Store A\'s sale', async () => {
    const res = await request(app).post('/api/payments').set('Authorization', `Bearer ${storeBToken}`)
      .send({ direction: 'incoming', sale_id: storeASaleId, method: 'cash', amount: 1000 });
    expect(res.status).toBe(404);
  });

  it('1.5 — Store A can still record a payment against its own sale (no regression)', async () => {
    const res = await request(app).post('/api/payments').set('Authorization', `Bearer ${storeAToken}`)
      .send({ direction: 'incoming', sale_id: storeASaleId, method: 'cash', amount: 100 });
    expect(res.status).toBe(201);
  });
});
