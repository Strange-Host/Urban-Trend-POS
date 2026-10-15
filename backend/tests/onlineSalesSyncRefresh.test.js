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

describe('re-syncing', () => {
  it('is idempotent: the same orders are skipped, not duplicated', async () => {
    const src = await newSource('Idem');
    fetchSpy.mockResolvedValue([sOrder(2001, 2), sOrder(2002, 4)]);
    await sync(src.id);
    const again = await sync(src.id);
    expect(again.body.data).toMatchObject({ imported: 0, updated: 0, skipped: 2 });
    expect(db.prepare("SELECT COUNT(*) n FROM sales WHERE income_source_id = ?").get(src.id).n).toBe(2);
  });

  it('a cancelled or refunded order flips the existing sale to voided/refunded instead of being ignored', async () => {
    const src = await newSource('Status');
    fetchSpy.mockResolvedValue([sOrder(3001, 2), sOrder(3002, 3)]);
    await sync(src.id);
    fetchSpy.mockResolvedValue([sOrder(3001, 2, { cancelled_at: iso(1) }), sOrder(3002, 3, { financial_status: 'refunded' })]);
    const res = await sync(src.id);
    expect(res.body.data).toMatchObject({ imported: 0, updated: 2 });
    const status = (n) => db.prepare('SELECT status FROM sales WHERE income_source_id = ? AND external_order_number = ?').get(src.id, n).status;
    expect(status('#3001')).toBe('voided');
    expect(status('#3002')).toBe('refunded');
  });

  it('a changed total is updated too', async () => {
    const src = await newSource('Reprice');
    fetchSpy.mockResolvedValue([sOrder(3101, 2)]);
    await sync(src.id);
    fetchSpy.mockResolvedValue([sOrder(3101, 2, { total_price: '1200.00' })]);
    expect((await sync(src.id)).body.data.updated).toBe(1);
    expect(db.prepare('SELECT total FROM sales WHERE income_source_id = ?').get(src.id).total).toBe(120000);
  });
});

describe('one bad order no longer blocks the rest', () => {
  it('imports the good ones, reports the bad one, and does NOT advance the watermark (so it is retried)', async () => {
    const src = await newSource('Isolation');
    const broken = sOrder(4002, 3);
    broken.line_items = [{ title: 'Boom', sku: 'BOOM-1', quantity: 1, price: '100.00', tax_lines: [], total_discount: '0.00' }];
    // a NOT NULL violation deep inside the import - simulates any malformed order
    broken.created_at = null;
    fetchSpy.mockResolvedValue([sOrder(4001, 2), broken, sOrder(4003, 5)]);

    const res = await sync(src.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ imported: 2, failed: 1, total: 3 });
    expect(res.body.data.errors[0]).toContain('#4002');
    expect(db.prepare('SELECT COUNT(*) n FROM sales WHERE income_source_id = ?').get(src.id).n).toBe(2);
    expect(db.prepare('SELECT last_sales_synced_at FROM income_sources WHERE id = ?').get(src.id).last_sales_synced_at).toBeNull();

    // fixed upstream -> next sync picks it up
    fetchSpy.mockResolvedValue([sOrder(4001, 2), sOrder(4002, 3), sOrder(4003, 5)]);
    const retry = await sync(src.id);
    expect(retry.body.data).toMatchObject({ imported: 1, skipped: 2, failed: 0 });
    expect(db.prepare('SELECT last_sales_synced_at FROM income_sources WHERE id = ?').get(src.id).last_sales_synced_at).not.toBeNull();
  });
});

describe('Shopify\'s 60-day window is explained, not mysterious', () => {
  it('asking for a year and getting only recent orders produces a read_all_orders hint', async () => {
    const src = await newSource('Window A');
    fetchSpy.mockResolvedValue([sOrder(5001, 5), sOrder(5002, 40), sOrder(5003, 58)]);
    const res = await sync(src.id, { days: 365 });
    expect(res.body.data.hint).toContain('read_all_orders');
    expect(res.body.data.mode).toBe('last_365_days');
    expect(res.body.data.oldest_order_at).toBeTruthy();
  });

  it('no hint when older orders DID come back (the scope is clearly working)', async () => {
    const src = await newSource('Window B');
    fetchSpy.mockResolvedValue([sOrder(5101, 5), sOrder(5102, 200)]);
    expect((await sync(src.id, { days: 365 })).body.data.hint).toBeUndefined();
  });

  it('no hint for a normal incremental sync or when the scope is granted', async () => {
    const src = await newSource('Window C');
    fetchSpy.mockResolvedValue([sOrder(5201, 5)]);
    expect((await sync(src.id)).body.data.hint).toBeUndefined();
    db.prepare("UPDATE income_sources SET oauth_scopes = 'read_orders,read_all_orders' WHERE id = ?").run(src.id);
    expect((await sync(src.id, { days: 365 })).body.data.hint).toBeUndefined();
  });

  it('an empty answer to a long backfill points at the read_orders scope', async () => {
    const src = await newSource('Window D');
    fetchSpy.mockResolvedValue([]);
    expect((await sync(src.id, { all: true })).body.data.hint).toContain('read_orders');
  });
});

describe('Test connection checks order access, not just the shop', () => {
  async function test(src) { return (await request(app).post(`/api/income-sources/${src.id}/test`).set(a)).body.data.message; }

  it('reports the order count and the 60-day caveat', async () => {
    const src = await newSource('Test A');
    db.prepare("UPDATE income_sources SET oauth_scopes = 'read_orders,read_products' WHERE id = ?").run(src.id);
    vi.spyOn(shopify, 'ping').mockResolvedValue({ name: 'Urban Trends', domain: 'x.myshopify.com' });
    vi.spyOn(shopify, 'countOrders').mockResolvedValue(42);
    const msg = await test(src);
    expect(msg).toContain('Orders this app can see: 42');
    expect(msg).toContain('last 60 days');
  });

  it('says "add read_orders" when Shopify refuses the orders call, instead of a cheerful "Connected"', async () => {
    const src = await newSource('Test B');
    vi.spyOn(shopify, 'ping').mockResolvedValue({ name: 'Urban Trends', domain: 'x.myshopify.com' });
    vi.spyOn(shopify, 'countOrders').mockRejectedValue(Object.assign(new Error('403'), { response: { status: 403 } }));
    const msg = await test(src);
    expect(msg).toContain('WARNING');
    expect(msg).toContain('read_orders');
  });

  it('no 60-day caveat once read_all_orders is granted', async () => {
    const src = await newSource('Test C');
    db.prepare("UPDATE income_sources SET oauth_scopes = 'read_orders,read_all_orders' WHERE id = ?").run(src.id);
    vi.spyOn(shopify, 'ping').mockResolvedValue({ name: 'Urban Trends', domain: 'x.myshopify.com' });
    vi.spyOn(shopify, 'countOrders').mockResolvedValue(900);
    expect(await test(src)).not.toContain('last 60 days');
  });
});

describe('WooCommerce uses the same machinery', () => {
  it('imports into the user\'s store, is visible, and refreshes status on re-sync', async () => {
    const res = await request(app).post('/api/income-sources').set(a).send({ name: 'Sister Woo', platform: 'woocommerce', site_url: 'https://sister.example.com', consumer_key: 'ck', consumer_secret: 'cs' });
    expect(res.status).toBe(201);
    const wooSpy = vi.spyOn(woocommerce, 'fetchOrders');
    const wOrder = (id, status = 'completed') => ({ id, number: String(id), status, total: '800.00', discount_total: '0', date_created: iso(2), payment_method_title: 'M-Pesa',
      line_items: [{ name: 'Wooden Desk', sku: '', quantity: 1, subtotal: '800.00', total: '800.00', total_tax: '0' }] });
    wooSpy.mockResolvedValue([wOrder(900)]);
    const first = await sync(res.body.data.id);
    expect(first.body.data.imported).toBe(1);
    expect((await salesList('source_type=woocommerce')).body.total).toBe(1);

    wooSpy.mockResolvedValue([wOrder(900, 'cancelled')]);
    expect((await sync(res.body.data.id)).body.data.updated).toBe(1);
    expect(db.prepare("SELECT status FROM sales WHERE income_source_id = ?").get(res.body.data.id).status).toBe('voided');
    expect(wooSpy.mock.calls[1][1].updatedSince).toBeTruthy(); // modified_after on the incremental run
  });
});
