const axios = require('axios');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const shopify = require('../src/config/shopify');
const woocommerce = require('../src/config/woocommerce');
const shopifyOAuth = require('../src/services/shopifyOAuth.service');
const { resolveProduct } = require('../src/services/salesSync.service');

let token;
let a;
let fetchSpy;
const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

const sOrder = (id, daysAgo, over = {}) => ({
  id, name: `#${id}`, order_number: id, created_at: iso(daysAgo), financial_status: 'paid', total_price: '1500.00', total_discounts: '0.00',
  line_items: [{ title: 'Leather Chair', sku: 'CHAIR-1', quantity: 1, price: '1500.00', tax_lines: [], total_discount: '0.00' }], ...over,
});

async function newSource(name = 'Main Shopify', extra = {}) {
  const res = await request(app).post('/api/income-sources').set(a).send({ name, platform: 'shopify', shop_domain: 'x.myshopify.com', api_key: 'k', api_secret: 's', ...extra });
  expect(res.status).toBe(201);
  return res.body.data;
}
const sync = (id, body) => request(app).post(`/api/income-sources/${id}/sync-sales`).set(a).send(body || {}).then((r) => { if (r.status !== 200 && process.env.DEBUG_SYNC) console.log('SYNC-ERR', r.status, JSON.stringify(r.body)); return r; });
const salesList = (q = '') => request(app).get(`/api/sales?${q}`).set(a);

beforeAll(async () => {
  token = await loginAsAdmin();
  a = { Authorization: `Bearer ${token}` };
  vi.spyOn(shopifyOAuth, 'ensureFreshToken').mockImplementation(async (s) => s);
  fetchSpy = vi.spyOn(shopify, 'fetchOrders');
});
// braces matter: vitest treats a function RETURNED from beforeEach as a cleanup hook and calls it
beforeEach(() => { fetchSpy.mockReset(); });
afterAll(() => cleanupTestDb());

// The sync endpoints share a rate limit of 20 requests / 15 minutes (config/limits.js),
// and this is a real limiter that counts every request - so the sync tests are split
// across two files, each under that budget, rather than weakening the limiter.

describe('imported orders are visible in Sales history (the "imported 25 of 25 but nothing shows" bug)', () => {
  it('a new source defaults to the creator\'s store, and its imported sales appear under the Shopify filter', async () => {
    const src = await newSource();
    const adminStore = db.prepare("SELECT store_id FROM users WHERE email = 'admin@urbantrends.com'").get().store_id;
    expect(src.store_id).toBe(adminStore);

    fetchSpy.mockResolvedValue([sOrder(1001, 3), sOrder(1002, 10)]);
    const res = await sync(src.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ imported: 2, updated: 0, skipped: 0, failed: 0, total: 2 });

    const list = await salesList('source_type=shopify');
    expect(list.body.total).toBe(2);
    expect(list.body.data.map((s) => s.external_order_number).sort()).toEqual(['#1001', '#1002']);
    expect(list.body.data[0].income_source_name).toBe('Main Shopify');
  });

  it('repairs a source that already synced under an invented store: its old sales move over', async () => {
    const src = await newSource('Legacy Shopify');
    db.prepare('UPDATE income_sources SET store_id = NULL WHERE id = ?').run(src.id);
    const stray = db.prepare("INSERT INTO stores (name, is_active) VALUES ('Legacy Shopify', 1)").run().lastInsertRowid;
    const adminId = db.prepare("SELECT id FROM users WHERE email = 'admin@urbantrends.com'").get().id;
    const pid = db.prepare('SELECT id FROM products LIMIT 1').get().id;
    const oldSale = db.prepare(`INSERT INTO sales (store_id, cashier_id, subtotal, tax_total, discount_total, total, payment_method, status, source_type, income_source_id, external_order_id, external_order_number, created_at)
      VALUES (?, ?, 100, 0, 0, 100, 'card', 'completed', 'shopify', ?, 'legacy-1', '#LEG1', datetime('now'))`).run(stray, adminId, src.id).lastInsertRowid;
    db.prepare('INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, tax_rate, discount, line_total) VALUES (?, ?, 1, 100, 0, 0, 100)').run(oldSale, pid);
    expect((await salesList('source_type=shopify')).body.data.map((s) => s.external_order_number)).not.toContain('#LEG1');

    fetchSpy.mockResolvedValue([]);
    await sync(src.id);
    const adminStore = db.prepare("SELECT store_id FROM users WHERE email = 'admin@urbantrends.com'").get().store_id;
    expect(db.prepare('SELECT store_id FROM sales WHERE id = ?').get(oldSale).store_id).toBe(adminStore);
    expect(db.prepare('SELECT store_id FROM income_sources WHERE id = ?').get(src.id).store_id).toBe(adminStore);
    expect((await salesList('source_type=shopify')).body.data.map((s) => s.external_order_number)).toContain('#LEG1');
  });
});

describe('how far back it looks', () => {
  it('first sync looks back 60 days (Shopify\'s own default window), as a created-since backfill', async () => {
    const src = await newSource('Depth A');
    fetchSpy.mockResolvedValue([]);
    await sync(src.id);
    const f = fetchSpy.mock.calls[0][1];
    expect(f.updatedSince).toBeUndefined();
    const days = (Date.now() - Date.parse(f.createdSince)) / DAY;
    expect(days).toBeGreaterThan(59.9);
    expect(days).toBeLessThan(60.1);
  });

  it('{ days: 365 } and { all: true } let you choose the depth', async () => {
    const src = await newSource('Depth B');
    fetchSpy.mockResolvedValue([]);
    await sync(src.id, { days: 365 });
    expect((Date.now() - Date.parse(fetchSpy.mock.calls[0][1].createdSince)) / DAY).toBeGreaterThan(364.9);
    await sync(src.id, { all: true });
    expect(fetchSpy.mock.calls[1][1].createdSince).toBe('2000-01-01T00:00:00Z');
  });

  it('rejects nonsense depths', async () => {
    const src = await newSource('Depth C');
    for (const body of [{ days: 0 }, { days: -5 }, { days: 1.5 }, { days: 99999 }, { days: '30' }, { all: 'yes' }]) {
      expect((await sync(src.id, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('after the first sync, later syncs ask for orders UPDATED since the watermark (so cancellations and refunds arrive)', async () => {
    const src = await newSource('Depth D');
    fetchSpy.mockResolvedValue([]);
    await sync(src.id);
    await sync(src.id);
    const second = fetchSpy.mock.calls[1][1];
    expect(second.createdSince).toBeUndefined();
    expect(second.updatedSince).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('the watermark is when the sync STARTED (minus a 60s margin), not when it finished', async () => {
    const src = await newSource('Depth E');
    let resolveFetch;
    fetchSpy.mockImplementation(() => new Promise((r) => { resolveFetch = r; }));
    const before = Date.now();
    // supertest only sends the request once it is awaited or .then()-ed, so
    // attach .then() NOW - otherwise the sync would not have started yet.
    const pending = sync(src.id).then((r) => r);
    await new Promise((r) => setTimeout(r, 400)); // the "download" is slow
    resolveFetch([]);
    await pending;
    const stored = db.prepare('SELECT last_sales_synced_at FROM income_sources WHERE id = ?').get(src.id).last_sales_synced_at;
    const storedMs = Date.parse(`${stored.replace(' ', 'T')}Z`);
    expect(storedMs).toBeLessThanOrEqual(before - 59000);   // margin applied
    expect(storedMs).toBeGreaterThan(before - 62000);
  });
});

describe('placeholder products', () => {
  it('two different un-SKU\'d products with the same first 12 characters stay different (they used to merge)', () => {
    const black = resolveProduct(null, 'Leather Office Chair Black', 100);
    const brown = resolveProduct(null, 'Leather Office Chair Brown', 100);
    expect(black).not.toBe(brown);
    expect(resolveProduct(null, 'Leather Office Chair Black', 100)).toBe(black); // same name still reuses its row
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(black);
    expect(row.is_active).toBe(0); // kept out of the POS
    expect(row.sku).toMatch(/^EXT-[0-9A-F]{12}$/);
  });

  it('reuses a placeholder made by the old scheme only when the name matches exactly', () => {
    const name = 'Standing Desk Walnut';
    const legacySku = `EXT-${Buffer.from(name).toString('base64').slice(0, 16)}`;
    const legacyId = db.prepare("INSERT INTO products (sku, name, cost_price, sell_price, tax_rate, is_active) VALUES (?, ?, 0, 10, 0, 1)").run(legacySku, name).lastInsertRowid;
    expect(resolveProduct(null, name, 10)).toBe(legacyId);
    const other = resolveProduct(null, 'Standing Desk Oak!!!', 10); // same first 12 bytes, different product
    expect(other).not.toBe(legacyId);
  });

  it('an order whose line item has no title or sku no longer throws', () => {
    expect(() => resolveProduct(null, undefined, 0)).not.toThrow();
  });
});

describe('fetchOrders builds the right request and follows pagination', () => {
  function mockClient(pages) {
    const get = vi.fn();
    pages.forEach((p) => get.mockResolvedValueOnce(p));
    const client = { get, defaults: { baseURL: 'https://x.myshopify.com/admin/api/2026-01' } };
    vi.spyOn(axios, 'create').mockReturnValue(client);
    return get;
  }
  const real = () => require('../src/config/shopify');
  afterEach(() => vi.restoreAllMocks());

  it('created-since vs updated-since map to created_at_min vs updated_at_min, and next pages are followed', async () => {
    fetchSpy.mockRestore?.();
    const get = mockClient([
      { data: { orders: [{ id: 1 }] }, headers: { link: '<https://x.myshopify.com/admin/api/2026-01/orders.json?limit=250&page_info=abc>; rel="next"' } },
      { data: { orders: [{ id: 2 }] }, headers: {} },
    ]);
    const orders = await real().fetchOrders({ shop_domain: 'x.myshopify.com', access_token: 't' }, { createdSince: '2026-01-01T00:00:00Z' });
    expect(orders.map((o) => o.id)).toEqual([1, 2]);
    expect(get.mock.calls[0][0]).toBe('/orders.json?limit=250&status=any&created_at_min=2026-01-01T00%3A00%3A00Z');
    expect(get.mock.calls[1][0]).toBe('/orders.json?limit=250&page_info=abc');
  });

  it('updated-since uses updated_at_min only', async () => {
    const get = mockClient([{ data: { orders: [] }, headers: {} }]);
    await real().fetchOrders({ shop_domain: 'x.myshopify.com', access_token: 't' }, { updatedSince: '2026-02-02T10:00:00Z' });
    expect(get.mock.calls[0][0]).toBe('/orders.json?limit=250&status=any&updated_at_min=2026-02-02T10%3A00%3A00Z');
  });
});

