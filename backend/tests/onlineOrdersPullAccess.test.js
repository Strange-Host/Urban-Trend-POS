// Split from onlineOrdersPull.test.js: the pull endpoint shares the real 20-requests/15-minutes sync rate limit.
const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const shopify = require('../src/config/shopify');
const woocommerce = require('../src/config/woocommerce');
const shopifyOAuth = require('../src/services/shopifyOAuth.service');
const onlineOrders = require('../src/services/onlineOrders.service');

let token; let a; let product; let cashier; let fetchSpy;
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const sOrder = (id, over = {}) => ({
  id, name: `#${id}`, order_number: id, created_at: iso(2), financial_status: 'paid', fulfillment_status: null, cancelled_at: null,
  total_price: '3000.00', total_discounts: '0.00', payment_gateway_names: ['shopify_payments'],
  email: `buyer${id}@example.com`, phone: null,
  shipping_address: { name: 'Grace Wanjiku', phone: `07110${id}`.slice(0, 10), city: 'Nairobi' },
  customer: { first_name: 'Grace', last_name: 'Wanjiku' },
  line_items: [{ title: product.name, sku: product.sku, quantity: 2, price: '1500.00', total_discount: '0.00', tax_lines: [] }], ...over,
});

async function newSource(name, platform = 'shopify') {
  const body = platform === 'shopify'
    ? { name, platform, shop_domain: 'x.myshopify.com', api_key: 'k', api_secret: 's' }
    : { name, platform, site_url: 'https://woo.example.com', consumer_key: 'ck', consumer_secret: 'cs' };
  const src = (await request(app).post('/api/income-sources').set(a).send(body)).body.data;
  // pretend the connection is established
  if (platform === 'shopify') db.prepare("UPDATE income_sources SET access_token = 'enc-test', oauth_scopes = 'read_orders' WHERE id = ?").run(src.id);
  return src;
}
const pull = (id, body = {}) => request(app).post('/api/orders/pull-online').set(a).send({ income_source_id: id, ...body });
const orderBy = (sourceId, ext) => db.prepare('SELECT * FROM orders WHERE income_source_id = ? AND external_order_id = ?').get(sourceId, String(ext));

beforeAll(async () => {
  token = await loginAsAdmin(); a = auth(token);
  product = (await request(app).get('/api/products?pageSize=1').set(a)).body.data[0];
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  db.prepare("INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'Cash', 'cash-online@urbantrends.com', ?, 'cashier', 1)").run(store.id, bcrypt.hashSync('Passw0rd!Passw0rd', 10));
  cashier = (await request(app).post('/api/auth/login').send({ email: 'cash-online@urbantrends.com', password: 'Passw0rd!Passw0rd' })).body.token;
  vi.spyOn(shopifyOAuth, 'ensureFreshToken').mockImplementation(async (s) => s);
  fetchSpy = vi.spyOn(shopify, 'fetchOrders');
});
beforeEach(() => { fetchSpy.mockReset(); });
afterAll(() => cleanupTestDb());

describe('access and validation', () => {
  it('only people allowed to pull orders can see or use it', async () => {
    expect((await request(app).get('/api/orders/online-sources').set(auth(cashier))).status).toBe(403);
    expect((await request(app).post('/api/orders/pull-online').set(auth(cashier)).send({ income_source_id: 1 })).status).toBe(403);
    expect((await request(app).get('/api/orders/online-sources')).status).toBe(401);
  });

  it('lists only connected connections, with no secrets', async () => {
    await newSource('Connected Shop');
    await newSource('Unconnected Shop'); db.prepare("UPDATE income_sources SET access_token = NULL WHERE name = 'Unconnected Shop'").run();
    const list = (await request(app).get('/api/orders/online-sources').set(a)).body.data;
    expect(list.map((s) => s.name)).toEqual(['Connected Shop']);
    expect(Object.keys(list[0]).sort()).toEqual(['id', 'name', 'platform']);
  });

  it('validates the request', async () => {
    for (const body of [{}, { income_source_id: 'x' }, { income_source_id: 1, days: 0 }, { income_source_id: 1, days: 9999 }, { income_source_id: 1, days: 1.5 }]) {
      expect((await request(app).post('/api/orders/pull-online').set(a).send(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(app).post('/api/orders/pull-online').set(a).send({ income_source_id: 424242 })).status).toBe(404);
  });

  it('normalizers tolerate sparse payloads', () => {
    expect(() => onlineOrders.normalizeShopify({ id: 1 })).not.toThrow();
    expect(() => onlineOrders.normalizeWoo({ id: 1 })).not.toThrow();
  });
});

describe('Orders page channel tabs (same split as Sales history)', () => {
  it('filters by channel, reports the source name, and rejects unknown channels', async () => {
    const created = (await request(app).post('/api/orders').set(a).send({ name: 'Local Buyer', phone: '0722999001', payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] })).body.data;
    const src = await newSource('Tab Shop');
    vi.spyOn(shopify, 'fetchOrders').mockResolvedValue([sOrder(7001)]);
    await pull(src.id);
    const list = (q) => request(app).get(`/api/orders?${q}`).set(a);

    const manual = (await list('channel=manual')).body.data;
    expect(manual.every((o) => o.channel === 'manual')).toBe(true);
    expect(manual.map((o) => o.id)).toContain(created.id);

    const shop = (await list('channel=shopify')).body.data;
    expect(shop).toHaveLength(1);
    expect(shop[0]).toMatchObject({ channel: 'shopify', income_source_name: 'Tab Shop' });
    expect((await list('channel=wordpress')).body.total).toBe(0);
    expect((await list('')).body.total).toBe(manual.length + 1);        // "All channels" = the sum
    expect((await list('channel=amazon')).status).toBe(400);
  });

  it('two WooCommerce sites that both have an order #700 no longer collide', async () => {
    const wA = await newSource('Woo A', 'woocommerce');
    const wB = await newSource('Woo B', 'woocommerce');
    const wooOrder = (phone) => ({ id: 700, number: '700', status: 'processing', date_created: iso(1), date_paid: iso(1), payment_method: 'bacs', payment_method_title: 'Bank',
      billing: { first_name: 'X', last_name: 'Y', phone, city: 'Nairobi' }, shipping: {}, line_items: [{ name: product.name, sku: product.sku, quantity: 1, subtotal: '1500', total: '1500', total_tax: '0' }] });
    const spy = vi.spyOn(woocommerce, 'fetchOrders');
    spy.mockResolvedValue([wooOrder('0733111001')]); expect((await pull(wA.id)).body.data.imported).toBe(1);
    spy.mockResolvedValue([wooOrder('0733111002')]); const second = await pull(wB.id);
    expect(second.body.data).toMatchObject({ imported: 1, failed: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM orders WHERE external_order_id = '700' AND channel = 'wordpress'").get().n).toBe(2);
  });
});
