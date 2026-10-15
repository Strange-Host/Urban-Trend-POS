const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const shopify = require('../src/config/shopify');
const woocommerce = require('../src/config/woocommerce');
const shopifyOAuth = require('../src/services/shopifyOAuth.service');
const shopifyService = require('../src/services/shopify.service');
const salesSync = require('../src/services/salesSync.service');
const onlineOrders = require('../src/services/onlineOrders.service');
const productSync = require('../src/services/productSync.service');
const liveSync = require('../src/services/liveSync.service');

let a; let product; let manager; let cashier;
const SECRET = 'shpss_client_secret_for_tests';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const iso = (d = 0) => new Date(Date.now() - d * 86400000).toISOString();

const sOrder = (id, over = {}) => ({
  id, name: `#${id}`, order_number: id, created_at: iso(1), updated_at: iso(0.01), financial_status: 'paid', fulfillment_status: null, cancelled_at: null,
  total_price: '3000.00', total_discounts: '0.00', payment_gateway_names: ['shopify_payments'], email: `b${id}@example.com`,
  shipping_address: { name: 'Grace Wanjiku', phone: `07110${id}`.slice(0, 10), city: 'Nairobi' }, customer: { first_name: 'Grace', last_name: 'Wanjiku' },
  line_items: [{ title: product.name, sku: product.sku, quantity: 2, price: '1500.00', total_discount: '0.00', tax_lines: [] }], ...over,
});

async function newSource(name, platform = 'shopify', extra = {}) {
  const body = platform === 'shopify'
    ? { name, platform, shop_domain: 'live.myshopify.com', api_key: 'k', api_secret: SECRET }
    : { name, platform, site_url: 'https://woo.example.com', consumer_key: 'ck', consumer_secret: 'cs' };
  const src = (await request(app).post('/api/income-sources').set(a).send(body)).body.data;
  if (platform === 'shopify') db.prepare("UPDATE income_sources SET access_token = 'enc-test', oauth_scopes = 'read_orders,read_products' WHERE id = ?").run(src.id);
  if (extra.liveOn) db.prepare('UPDATE income_sources SET live_sync_enabled = 1 WHERE id = ?').run(src.id);
  return src;
}

// A delivery exactly as the store sends it: signed over the exact bytes of the body.
function shopifyDelivery(src, topic, payload, { secret = SECRET, id = crypto.randomUUID(), shop = 'live.myshopify.com' } = {}) {
  const raw = JSON.stringify(payload);
  return request(app).post(`/api/integrations/webhooks/shopify/${src.id}`)
    .set('Content-Type', 'application/json').set('X-Shopify-Topic', topic).set('X-Shopify-Webhook-Id', id)
    .set('X-Shopify-Shop-Domain', shop).set('X-Shopify-Hmac-Sha256', crypto.createHmac('sha256', secret).update(raw).digest('base64')).send(raw);
}
function wooDelivery(src, secret, topic, payload, { id = crypto.randomUUID() } = {}) {
  const raw = JSON.stringify(payload);
  return request(app).post(`/api/integrations/webhooks/woocommerce/${src.id}`)
    .set('Content-Type', 'application/json').set('X-WC-Webhook-Topic', topic).set('X-WC-Webhook-Delivery-ID', id)
    .set('X-WC-Webhook-Signature', crypto.createHmac('sha256', secret).update(raw).digest('base64')).send(raw);
}
const sale = (src, ext) => db.prepare('SELECT * FROM sales WHERE income_source_id = ? AND external_order_id = ?').get(src.id, String(ext));
const order = (src, ext) => db.prepare('SELECT * FROM orders WHERE income_source_id = ? AND external_order_id = ?').get(src.id, String(ext));
const events = (src) => db.prepare('SELECT * FROM webhook_events WHERE income_source_id = ? ORDER BY id').all(src.id);

beforeAll(async () => {
  a = auth(await loginAsAdmin());
  product = (await request(app).get('/api/products?pageSize=1').set(a)).body.data[0];
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  const mk = (role, email) => { db.prepare("INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)").run(store.id, role, email, bcrypt.hashSync('Passw0rd!Passw0rd', 10), role); };
  mk('manager', 'mgr-live@urbantrends.com'); mk('cashier', 'cash-live@urbantrends.com');
  manager = (await request(app).post('/api/auth/login').send({ email: 'mgr-live@urbantrends.com', password: 'Passw0rd!Passw0rd' })).body.token;
  cashier = (await request(app).post('/api/auth/login').send({ email: 'cash-live@urbantrends.com', password: 'Passw0rd!Passw0rd' })).body.token;
  vi.spyOn(shopifyOAuth, 'ensureFreshToken').mockImplementation(async (s) => s);
  await request(app).put('/api/system/config').set(a).send({ values: { public_base_url: 'https://pos.example.co.ke' } });
});
afterAll(() => cleanupTestDb());

describe('turning live sync on and off', () => {
  it('needs a public https address first, and says where to set it', async () => {
    const src = await newSource('Needs URL');
    await request(app).put('/api/system/config').set(a).send({ values: { public_base_url: '' } });
    let res = await request(app).post(`/api/income-sources/${src.id}/live-sync/enable`).set(a);
    expect(res.status).toBe(400); expect(res.body.error.message).toContain('Server & public address');
    await request(app).put('/api/system/config').set(a).send({ values: { public_base_url: 'http://192.168.1.5:4000' } });
    res = await request(app).post(`/api/income-sources/${src.id}/live-sync/enable`).set(a);
    expect(res.status).toBe(400); expect(res.body.error.message).toContain('https://');
    await request(app).put('/api/system/config').set(a).send({ values: { public_base_url: 'https://pos.example.co.ke' } });
  });

  it('registers all six Shopify topics at this connection\'s own address, and records them', async () => {
    const src = await newSource('Shop On');
    vi.spyOn(shopify, 'listWebhooks').mockResolvedValue([]);
    let n = 100;
    const create = vi.spyOn(shopify, 'createWebhook').mockImplementation(async () => ({ id: n++ }));
    const res = await request(app).post(`/api/income-sources/${src.id}/live-sync/enable`).set(a);
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.address).toBe(`https://pos.example.co.ke/api/integrations/webhooks/shopify/${src.id}`);
    expect(create.mock.calls.map((c) => c[1]).sort()).toEqual([...liveSync.SHOPIFY_TOPICS].sort());
    expect(db.prepare('SELECT live_sync_enabled FROM income_sources WHERE id = ?').get(src.id).live_sync_enabled).toBe(1);
    expect(db.prepare('SELECT COUNT(*) n FROM income_source_webhooks WHERE income_source_id = ?').get(src.id).n).toBe(6);
  });

  it('is repeatable: webhooks already there are reused, and one pointing at an old address is moved', async () => {
    const src = await newSource('Shop Twice');
    const mine = `/api/integrations/webhooks/shopify/${src.id}`;
    vi.spyOn(shopify, 'listWebhooks').mockResolvedValue([
      { id: 1, topic: 'orders/create', address: `https://pos.example.co.ke${mine}` },
      { id: 2, topic: 'orders/updated', address: `https://old-tunnel.ngrok.app${mine}` },
    ]);
    const create = vi.spyOn(shopify, 'createWebhook').mockImplementation(async () => ({ id: 77 }));
    create.mockClear();
    const move = vi.spyOn(shopify, 'updateWebhookAddress').mockResolvedValue({ id: 2 });
    await request(app).post(`/api/income-sources/${src.id}/live-sync/enable`).set(a);
    expect(create.mock.calls.map((c) => c[1])).not.toContain('orders/create');
    expect(create.mock.calls).toHaveLength(4);
    expect(move).toHaveBeenCalledWith(expect.anything(), 2, `https://pos.example.co.ke${mine}`);
  });

  it('reports exactly what the store refused (a missing permission), and stays partly on', async () => {
    const src = await newSource('Shop Partial');
    vi.spyOn(shopify, 'listWebhooks').mockResolvedValue([]);
    vi.spyOn(shopify, 'createWebhook').mockImplementation(async (_s, topic) => {
      if (topic.startsWith('orders/')) throw Object.assign(new Error('x'), { response: { status: 403, data: {} } });
      return { id: 5 };
    });
    const res = (await request(app).post(`/api/income-sources/${src.id}/live-sync/enable`).set(a)).body.data;
    expect(res.enabled).toBe(true);
    expect(res.results.filter((r) => !r.ok)).toHaveLength(3);
    expect(res.results.find((r) => r.topic === 'orders/create').error).toContain('read_orders');
    expect(res.message).toContain('partly on');
  });

  it('refuses without the connection\'s client secret (Shopify signs with it)', async () => {
    const src = await newSource('No Secret');
    db.prepare('UPDATE income_sources SET api_secret = NULL WHERE id = ?').run(src.id);
    const res = await request(app).post(`/api/income-sources/${src.id}/live-sync/enable`).set(a);
    expect(res.status).toBe(400); expect(res.body.error.message).toContain('Client secret');
  });

  it('turning it off removes the webhooks from the store and tolerates ones already gone', async () => {
    const src = await newSource('Shop Off');
    vi.spyOn(shopify, 'listWebhooks').mockResolvedValue([]);
    let n = 200; vi.spyOn(shopify, 'createWebhook').mockImplementation(async () => ({ id: n++ }));
    await request(app).post(`/api/income-sources/${src.id}/live-sync/enable`).set(a);
    const del = vi.spyOn(shopify, 'deleteWebhook').mockImplementation(async (_s, id) => { if (id === '200') throw Object.assign(new Error('gone'), { response: { status: 404 } }); });
    const res = await request(app).post(`/api/income-sources/${src.id}/live-sync/disable`).set(a);
    expect(res.body.data).toEqual({ enabled: false, problems: [] });
    expect(del).toHaveBeenCalledTimes(6);
    expect(db.prepare('SELECT live_sync_enabled FROM income_sources WHERE id = ?').get(src.id).live_sync_enabled).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM income_source_webhooks WHERE income_source_id = ?').get(src.id).n).toBe(0);
  });

  it('is admin-only', async () => {
    expect((await request(app).post('/api/income-sources/1/live-sync/enable').set(auth(manager))).status).toBe(403);
    expect((await request(app).get('/api/income-sources/1/live-sync').set(auth(cashier))).status).toBe(403);
  });
});

describe('receiving Shopify deliveries', () => {
  let src;
  beforeAll(async () => { src = await newSource('Receiver', 'shopify', { liveOn: true }); });

  it('a correctly signed new order lands in Sales history AND the Orders page, and tells the team', async () => {
    const res = await shopifyDelivery(src, 'orders/create', sOrder(5001));
    expect(res.status).toBe(200); expect(res.body.status).toBe('processed');
    expect(sale(src, 5001)).toMatchObject({ status: 'completed', total: 300000 });
    const o = order(src, 5001);
    expect(o).toMatchObject({ channel: 'shopify', status: 'awaiting_dispatch', payment_type: 'prepaid', sale_id: sale(src, 5001).id });
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@urbantrends.com'").get().id;
    const note = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND type = 'online_order' AND entity_id = ?").get(admin, o.id);
    expect(note.title).toContain('#5001'); expect(note.body).toContain('added to Orders');
    expect(events(src).at(-1)).toMatchObject({ status: 'processed', topic: 'orders/create' });
    expect(db.prepare('SELECT last_webhook_at FROM income_sources WHERE id = ?').get(src.id).last_webhook_at).toBeTruthy();
  });

  it('rejects a bad signature, a wrong shop, and a wrong secret - and changes nothing', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM sales').get().n;
    expect((await shopifyDelivery(src, 'orders/create', sOrder(5002), { secret: 'not-the-secret' })).status).toBe(401);
    expect((await shopifyDelivery(src, 'orders/create', sOrder(5002), { shop: 'other-shop.myshopify.com' })).status).toBe(401);
    const unsigned = await request(app).post(`/api/integrations/webhooks/shopify/${src.id}`).set('X-Shopify-Topic', 'orders/create').send(sOrder(5002));
    expect(unsigned.status).toBe(401);
    expect(db.prepare('SELECT COUNT(*) n FROM sales').get().n).toBe(before);
    expect((await shopifyDelivery({ id: 99999 }, 'orders/create', sOrder(5002))).status).toBe(404);
  });

  it('a delivery tampered with after signing is rejected', async () => {
    const raw = JSON.stringify(sOrder(5003));
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('base64');
    const res = await request(app).post(`/api/integrations/webhooks/shopify/${src.id}`).set('Content-Type', 'application/json')
      .set('X-Shopify-Topic', 'orders/create').set('X-Shopify-Shop-Domain', 'live.myshopify.com').set('X-Shopify-Hmac-Sha256', sig)
      .send(raw.replace('3000.00', '1.00'));
    expect(res.status).toBe(401);
    expect(sale(src, 5003)).toBeUndefined();
  });

  it('a re-sent delivery (same id) is recognised and not processed twice', async () => {
    const id = 'delivery-abc';
    expect((await shopifyDelivery(src, 'orders/create', sOrder(5004), { id })).body.status).toBe('processed');
    const again = await shopifyDelivery(src, 'orders/create', sOrder(5004), { id });
    expect(again.body.status).toBe('duplicate');
    expect(db.prepare("SELECT COUNT(*) n FROM sales WHERE income_source_id = ? AND external_order_id = '5004'").get(src.id).n).toBe(1);
  });

  it('an update flows through: a cancellation voids the sale and cancels the order that is still waiting', async () => {
    await shopifyDelivery(src, 'orders/create', sOrder(5005));
    const res = await shopifyDelivery(src, 'orders/cancelled', sOrder(5005, { cancelled_at: iso(0), updated_at: new Date(Date.now() + 5000).toISOString() }));
    expect(res.body.status).toBe('processed');
    expect(sale(src, 5005).status).toBe('voided');
    expect(order(src, 5005).status).toBe('cancelled');
  });

  it('an order already dispatched is NOT cancelled by the store\'s cancellation (a person must handle it)', async () => {
    await shopifyDelivery(src, 'orders/create', sOrder(5006));
    await request(app).post(`/api/orders/${order(src, 5006).id}/dispatch`).set(a);
    await shopifyDelivery(src, 'orders/cancelled', sOrder(5006, { cancelled_at: iso(0), updated_at: new Date(Date.now() + 5000).toISOString() }));
    expect(sale(src, 5006).status).toBe('voided');
    expect(order(src, 5006).status).toBe('dispatched_paid');
  });

  it('a late, OLDER delivery cannot drag a newer state backwards', async () => {
    const newer = new Date(Date.now() + 60000).toISOString(); const older = new Date(Date.now() + 1000).toISOString();
    await shopifyDelivery(src, 'orders/create', sOrder(5007, { updated_at: iso(1) }));
    await shopifyDelivery(src, 'orders/updated', sOrder(5007, { cancelled_at: iso(0), updated_at: newer }));
    expect(sale(src, 5007).status).toBe('voided');
    await shopifyDelivery(src, 'orders/updated', sOrder(5007, { updated_at: older }));          // the stale "still paid" arrives last
    expect(sale(src, 5007).status).toBe('voided');
  });

  it('an order already shipped on the store updates Sales history but does not create work on the Orders page', async () => {
    await shopifyDelivery(src, 'orders/create', sOrder(5008, { fulfillment_status: 'fulfilled' }));
    expect(sale(src, 5008)).toBeTruthy();
    expect(order(src, 5008)).toBeUndefined();
  });

  it('with auto-import switched off, orders go to Sales history only', async () => {
    await request(app).put('/api/settings').set(a).send({ online_auto_import_orders: '0' });
    await shopifyDelivery(src, 'orders/create', sOrder(5009));
    expect(sale(src, 5009)).toBeTruthy(); expect(order(src, 5009)).toBeUndefined();
    await request(app).put('/api/settings').set(a).send({ online_auto_import_orders: '1' });
  });

  it('ignores deliveries while live sync is off for that connection', async () => {
    const off = await newSource('Receiver Off');
    const res = await shopifyDelivery(off, 'orders/create', sOrder(5010));
    expect(res.status).toBe(200); expect(res.body.status).toBe('ignored');
    expect(sale(off, 5010)).toBeUndefined();
  });

  it('a processing problem is answered 200 (so the store keeps the subscription) and recorded as failed', async () => {
    const boom = vi.spyOn(salesSync, 'importShopifyOrder').mockImplementationOnce(() => { throw new Error('database said no'); });
    const res = await shopifyDelivery(src, 'orders/create', sOrder(5011));
    expect(res.status).toBe(200); expect(res.body.status).toBe('failed');
    expect(events(src).at(-1)).toMatchObject({ status: 'failed', detail: 'database said no' });
    boom.mockRestore();
    const st = (await request(app).get(`/api/income-sources/${src.id}/live-sync`).set(a)).body.data;
    expect(st.events_24h.failed).toBeGreaterThanOrEqual(1);
    expect(st.recent_failures[0].detail).toBe('database said no');
  });

  it('accepts a large payload (over the normal 1 MB limit) as long as it is correctly signed', async () => {
    const big = sOrder(5012, { note: 'x'.repeat(1_500_000) });
    expect((await shopifyDelivery(src, 'orders/create', big)).body.status).toBe('processed');
  });
});

describe('product changes', () => {
  let src;
  beforeAll(async () => { src = await newSource('Product Receiver', 'shopify', { liveOn: true }); });
  const shopifyProduct = (id, title, price) => ({ id, title, handle: `p-${id}`, status: 'active', updated_at: '2026-10-01T10:00:00Z', variants: [{ id: id * 10, title: 'Default Title', sku: `LIVE-${id}`, price, inventory_quantity: 7, inventory_item_id: id * 100 }], image: null });

  it('a new or changed product reaches the review list at once, with a notification', async () => {
    const res = await shopifyDelivery(src, 'products/create', shopifyProduct(8001, 'Live Lamp', '1200.00'));
    expect(res.body.status).toBe('processed');
    const row = db.prepare("SELECT * FROM shopify_staging_products WHERE income_source_id = ? AND sku = 'LIVE-8001'").get(src.id);
    expect(row).toMatchObject({ name: expect.stringContaining('Live Lamp'), review_status: 'pending' });
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@urbantrends.com'").get().id;
    expect(db.prepare("SELECT title FROM notifications WHERE user_id = ? AND type = 'online_product'").get(admin).title).toContain('Live Lamp');

    const changed = await shopifyDelivery(src, 'products/update', shopifyProduct(8001, 'Live Lamp Deluxe', '1500.00'));
    expect(changed.body.status).toBe('processed');
    expect(db.prepare("SELECT name FROM shopify_staging_products WHERE income_source_id = ? AND sku = 'LIVE-8001'").get(src.id).name).toContain('Deluxe');
  });

  it('an unchanged product is a quiet no-op', async () => {
    const same = shopifyProduct(8001, 'Live Lamp Deluxe', '1500.00');
    expect((await shopifyDelivery(src, 'products/update', same)).body.status).toBe('ignored');
  });

  it('a product deleted on the store raises a warning instead of silently removing anything from the POS', async () => {
    const res = await shopifyDelivery(src, 'products/delete', { id: 8001 });
    expect(res.body.status).toBe('processed');
    expect(db.prepare("SELECT COUNT(*) n FROM shopify_staging_products WHERE income_source_id = ? AND sku = 'LIVE-8001'").get(src.id).n).toBe(1);
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@urbantrends.com'").get().id;
    expect(db.prepare("SELECT title FROM notifications WHERE user_id = ? AND title LIKE 'Product removed%'").get(admin).title).toContain('Live Lamp');
  });
});

describe('WooCommerce live sync', () => {
  it('creates webhooks with a generated secret (stored encrypted), or hands over manual steps for a read-only key', async () => {
    const writable = await newSource('Woo Write', 'woocommerce');
    vi.spyOn(woocommerce, 'listWebhooks').mockResolvedValue([]);
    let n = 1; const create = vi.spyOn(woocommerce, 'createWebhook').mockImplementation(async () => ({ id: n++ }));
    const ok = (await request(app).post(`/api/income-sources/${writable.id}/live-sync/enable`).set(a)).body.data;
    expect(ok.enabled).toBe(true); expect(ok.manual).toBeNull();
    expect(create).toHaveBeenCalledTimes(6);
    expect(create.mock.calls[0][1].deliveryUrl).toBe(`https://pos.example.co.ke/api/integrations/webhooks/woocommerce/${writable.id}`);
    const stored = db.prepare('SELECT webhook_secret FROM income_sources WHERE id = ?').get(writable.id).webhook_secret;
    expect(stored.startsWith('enc:v1:')).toBe(true);

    const readOnly = await newSource('Woo ReadOnly', 'woocommerce');
    create.mockImplementation(async () => { throw Object.assign(new Error('403'), { response: { status: 403, data: { code: 'woocommerce_rest_cannot_create' } } }); });
    const ro = (await request(app).post(`/api/income-sources/${readOnly.id}/live-sync/enable`).set(a)).body.data;
    expect(ro.enabled).toBe(false);
    expect(ro.message).toContain('read-only');
    expect(ro.manual).toMatchObject({ delivery_url: `https://pos.example.co.ke/api/integrations/webhooks/woocommerce/${readOnly.id}` });
    expect(ro.manual.secret).toHaveLength(64);
    expect(ro.manual.topics).toContain('order.created');
  });

  it('verifies the signature, answers the unsigned ping, and imports orders', async () => {
    const src = await newSource('Woo Receiver', 'woocommerce');
    const secret = 'woo-secret-for-tests';
    db.prepare('UPDATE income_sources SET live_sync_enabled = 1, webhook_secret = ? WHERE id = ?').run(require('../src/utils/crypto').encrypt(secret), src.id);

    const ping = await request(app).post(`/api/integrations/webhooks/woocommerce/${src.id}`).type('form').send({ webhook_id: '3' });
    expect(ping.status).toBe(200); expect(ping.body.status).toBe('pong');

    const wOrder = (id, over = {}) => ({ id, number: String(id), status: 'processing', date_created: iso(1), date_modified_gmt: new Date().toISOString().slice(0, 19), date_paid: iso(1), payment_method: 'bacs', payment_method_title: 'Bank',
      billing: { first_name: 'Joy', last_name: 'M', phone: '0733777001', city: 'Nairobi' }, shipping: {}, total: '2800.00',
      line_items: [{ name: product.name, sku: product.sku, quantity: 2, subtotal: '3000.00', total: '2800.00', total_tax: '0' }], ...over });

    expect((await wooDelivery(src, 'wrong-secret', 'order.created', wOrder(6001))).status).toBe(401);
    const res = await wooDelivery(src, secret, 'order.created', wOrder(6001));
    expect(res.body.status).toBe('processed');
    expect(order(src, 6001)).toMatchObject({ channel: 'wordpress', status: 'awaiting_dispatch', total: 280000 });

    const gone = await wooDelivery(src, secret, 'order.deleted', { id: 6001 });
    expect(gone.body.status).toBe('processed');
    expect(sale(src, 6001).status).toBe('voided');
    expect(order(src, 6001).status).toBe('cancelled');
    expect((await request(app).get(`/api/income-sources/${src.id}/live-sync`).set(a)).body.data.manual.secret).toBe(secret);
  });
});

describe('the safety-net poll', () => {
  const connect = async (name) => { const s = await newSource(name); return s; };
  beforeEach(() => { liveSync.resetPollState(); });

  it('checks each connected store, and only once per interval', async () => {
    const s1 = await connect('Poll One');
    const sync = vi.spyOn(salesSync, 'syncSales').mockResolvedValue({});
    const pull = vi.spyOn(onlineOrders, 'pullOrders').mockResolvedValue({});
    const prod = vi.spyOn(productSync, 'pullOne').mockResolvedValue({});
    db.prepare('UPDATE income_sources SET last_poll_at = NULL').run();
    const now = Date.now() + 60 * 60 * 1000 * 5;
    await liveSync.pollTick({ now });
    const mine = (spy) => spy.mock.calls.filter((c) => (c[0].id || c[0].incomeSourceId) === s1.id || c[0] === s1.id);
    expect(mine(sync).length).toBe(1); expect(mine(pull).length).toBe(1); expect(mine(prod).length).toBe(1);
    expect(db.prepare('SELECT last_poll_at, last_poll_error FROM income_sources WHERE id = ?').get(s1.id).last_poll_error).toBeNull();

    sync.mockClear();
    await liveSync.pollTick({ now: now + 2 * 60 * 1000 });                    // 2 minutes later: not due yet (10 min)
    expect(sync).not.toHaveBeenCalled();
  });

  it('one failing store does not stop the others, and the error is recorded for the Settings screen', async () => {
    const bad = await connect('Poll Bad'); const good = await connect('Poll Good');
    db.prepare("UPDATE income_sources SET last_poll_at = NULL WHERE id IN (?, ?)").run(bad.id, good.id);
    const sync = vi.spyOn(salesSync, 'syncSales').mockImplementation(async (s) => { if (s.id === bad.id) throw new Error('Shopify said no'); return {}; });
    vi.spyOn(onlineOrders, 'pullOrders').mockResolvedValue({}); vi.spyOn(productSync, 'pullOne').mockResolvedValue({});
    await liveSync.pollTick({ now: Date.now() + 10 * 3600 * 1000 });
    expect(db.prepare('SELECT last_poll_error FROM income_sources WHERE id = ?').get(bad.id).last_poll_error).toBe('Shopify said no');
    expect(db.prepare('SELECT last_poll_error FROM income_sources WHERE id = ?').get(good.id).last_poll_error).toBeNull();
    expect(sync.mock.calls.some((c) => c[0].id === good.id)).toBe(true);
  });

  it('can be switched off, and skips the Orders page when auto-import is off', async () => {
    const s = await connect('Poll Settings');
    db.prepare('UPDATE income_sources SET last_poll_at = NULL WHERE id = ?').run(s.id);
    const sync = vi.spyOn(salesSync, 'syncSales').mockResolvedValue({}); const pull = vi.spyOn(onlineOrders, 'pullOrders').mockResolvedValue({});
    vi.spyOn(productSync, 'pullOne').mockResolvedValue({});
    await request(app).put('/api/settings').set(a).send({ live_poll_minutes: '0' });
    expect(await liveSync.pollTick({ now: Date.now() + 99 * 3600 * 1000 })).toMatchObject({ skipped: true });
    await request(app).put('/api/settings').set(a).send({ live_poll_minutes: '10', online_auto_import_orders: '0' });
    sync.mockClear(); pull.mockClear();
    await liveSync.pollTick({ now: Date.now() + 99 * 3600 * 1000 });
    expect(sync).toHaveBeenCalled(); expect(pull).not.toHaveBeenCalled();
    await request(app).put('/api/settings').set(a).send({ online_auto_import_orders: '1' });
  });
});

describe('Shopify sync page: pull products from the connected store', () => {
  it('lists the connections (no secrets) for managers who may use the page, not cashiers', async () => {
    const ok = await request(app).get('/api/integrations/shopify/connections').set(auth(manager));
    expect(ok.status).toBe(200);
    expect(ok.body.data.length).toBeGreaterThan(0);
    expect(Object.keys(ok.body.data[0]).sort()).toEqual(['id', 'last_synced_at', 'live_sync_enabled', 'name', 'pending', 'platform']);
    expect((await request(app).get('/api/integrations/shopify/connections').set(auth(cashier))).status).toBe(403);
  });

  it('pulls from a chosen store, and from ALL stores when none is chosen - one failing does not hide the rest', async () => {
    const pullShopify = vi.spyOn(shopifyService, 'pullFromShopify').mockImplementation(async (s) => {
      if (s.name === 'Poll Bad') throw new Error('Shopify said no');
      return { created: 2, updated: 1, unchanged: 4, total: 7 };
    });
    const all = (await request(app).post('/api/integrations/shopify/sync').set(a).send({})).body.data;
    expect(all.results.length).toBeGreaterThan(1);
    expect(all.results.find((r) => r.name === 'Poll Bad')).toMatchObject({ ok: false, error: expect.stringContaining('no') });
    expect(all.created).toBeGreaterThanOrEqual(2);
    const first = productSync.connections().find((c) => c.platform === 'shopify' && c.name !== 'Poll Bad');
    const one = (await request(app).post('/api/integrations/shopify/sync').set(a).send({ income_source_id: first.id })).body.data;
    expect(one).toMatchObject({ created: 2, updated: 1, total: 7 });
    expect(db.prepare('SELECT last_synced_at FROM income_sources WHERE id = ?').get(first.id).last_synced_at).toBeTruthy();
    pullShopify.mockRestore();
  });

  it('with nothing connected, explains where to connect a store instead of asking for server settings', async () => {
    db.prepare('UPDATE income_sources SET is_active = 0').run();
    const res = await request(app).post('/api/integrations/shopify/sync').set(a).send({});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Settings > Income sources');
    expect(res.body.error.message).not.toContain('SHOPIFY_SHOP');
    db.prepare('UPDATE income_sources SET is_active = 1').run();
  });
});
