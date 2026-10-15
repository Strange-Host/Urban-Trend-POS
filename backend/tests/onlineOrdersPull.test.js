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

describe('why the Orders page was empty, and the new pull', () => {
  it('Sales history imports never create Orders-page orders (the original gap)', async () => {
    const src = await newSource('Gap Shop');
    fetchSpy.mockResolvedValue([sOrder(9001)]);
    await request(app).post(`/api/income-sources/${src.id}/sync-sales`).set(a).send({});
    expect((await request(app).get('/api/sales?source_type=shopify').set(a)).body.total).toBe(1);
    expect((await request(app).get('/api/orders').set(a)).body.total).toBe(0);
  });

  it('pulling creates a dispatchable order and LINKS (does not duplicate) the sale that was already imported', async () => {
    const src = (await request(app).get('/api/orders/online-sources').set(a)).body.data[0];
    fetchSpy.mockResolvedValue([sOrder(9001)]);
    const res = await pull(src.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ found: 1, imported: 1, skipped: 0, failed: 0 });

    const order = orderBy(src.id, 9001);
    expect(order).toMatchObject({ channel: 'shopify', status: 'awaiting_dispatch', payment_type: 'prepaid', total: 300000, amount_paid: 300000 });
    expect(order.product_code).toMatch(/^UT\d{6}$/);
    const sales = db.prepare("SELECT id FROM sales WHERE income_source_id = ? AND external_order_id = '9001'").all(src.id);
    expect(sales).toHaveLength(1);                       // still just ONE sale
    expect(order.sale_id).toBe(sales[0].id);             // ... and the order points at it
    expect((await request(app).get('/api/orders').set(a)).body.total).toBe(1);
  });

  it('is idempotent: pulling again changes nothing', async () => {
    const src = (await request(app).get('/api/orders/online-sources').set(a)).body.data[0];
    fetchSpy.mockResolvedValue([sOrder(9001)]);
    const again = await pull(src.id);
    expect(again.body.data).toMatchObject({ imported: 0, skipped: 1 });
    expect(db.prepare('SELECT COUNT(*) n FROM orders WHERE income_source_id = ?').get(src.id).n).toBe(1);
  });
});

describe('what gets imported', () => {
  it('skips orders already fulfilled or cancelled on the store (history, not work)', async () => {
    const src = await newSource('Filter Shop');
    fetchSpy.mockResolvedValue([sOrder(9101), sOrder(9102, { fulfillment_status: 'fulfilled' }), sOrder(9103, { cancelled_at: iso(1) }), sOrder(9104, { fulfillment_status: 'partial' })]);
    const res = await pull(src.id);
    expect(res.body.data).toMatchObject({ found: 4, imported: 2, ignored: 2 });
    expect(orderBy(src.id, 9101)).toBeTruthy(); expect(orderBy(src.id, 9104)).toBeTruthy();
    expect(orderBy(src.id, 9102)).toBeUndefined(); expect(orderBy(src.id, 9103)).toBeUndefined();
  });

  it('an unpaid / cash-on-delivery order becomes a COD order that needs the normal confirmation', async () => {
    const src = await newSource('COD Shop');
    fetchSpy.mockResolvedValue([sOrder(9201, { financial_status: 'pending', payment_gateway_names: ['Cash on Delivery (COD)'] })]);
    await pull(src.id);
    const order = orderBy(src.id, 9201);
    expect(order).toMatchObject({ payment_type: 'cod', amount_paid: 0, cod_confirmed_at: null });
    expect(order.cod_confirmation_expires_at).toBeTruthy();
    const dispatch = await request(app).post(`/api/orders/${order.id}/dispatch`).set(a);
    expect(dispatch.status).toBe(409);
    expect(dispatch.body.error.message).toContain('must be confirmed');
  });

  it('line prices, discounts and customer details are carried over', async () => {
    const src = await newSource('Detail Shop');
    fetchSpy.mockResolvedValue([sOrder(9301, { line_items: [{ title: product.name, sku: product.sku, quantity: 3, price: '1000.00', total_discount: '300.00', tax_lines: [] }] })]);
    await pull(src.id);
    const order = orderBy(src.id, 9301);
    expect(order).toMatchObject({ subtotal: 300000, discount_total: 30000, total: 270000, delivery_zone: 'nairobi' });
    const item = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(order.id);
    expect(item).toMatchObject({ quantity: 3, unit_price: 100000, discount: 30000, line_total: 270000 });
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(order.customer_id);
    expect(customer).toMatchObject({ name: 'Grace Wanjiku', city: 'Nairobi' });
    expect(order.notes).toContain('#9301');
  });

  it('a second order from the same customer is imported too (it is NOT blocked by the duplicate-active-order rule)', async () => {
    const src = await newSource('Repeat Shop');
    fetchSpy.mockResolvedValue([sOrder(9401), sOrder(9402)]);
    expect((await pull(src.id)).body.data.imported).toBe(2);
  });

  it('an order without a phone number fails alone, with a clear reason, and the rest still import', async () => {
    const src = await newSource('NoPhone Shop');
    fetchSpy.mockResolvedValue([sOrder(9501, { shipping_address: { name: 'No Phone', city: 'Thika' }, phone: null, customer: {} }), sOrder(9502)]);
    const res = await pull(src.id);
    expect(res.body.data).toMatchObject({ imported: 1, failed: 1 });
    expect(res.body.data.errors[0]).toContain('#9501');
    expect(res.body.data.errors[0]).toContain('phone');
    expect(orderBy(src.id, 9501)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) n FROM sales WHERE income_source_id = ? AND external_order_id = '9501'").get(src.id).n).toBe(0); // rolled back as a unit
  });
});

describe('already-paid orders and dispatch', () => {
  it('a prepaid online order dispatches straight to "paid" and deducts stock', async () => {
    const src = await newSource('Paid Shop');
    fetchSpy.mockResolvedValue([sOrder(9601, { line_items: [{ title: product.name, sku: product.sku, quantity: 1, price: '1500.00', total_discount: '0.00', tax_lines: [] }] })]);
    await pull(src.id);
    const order = orderBy(src.id, 9601);
    const before = db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(product.id).quantity;
    const res = await request(app).post(`/api/orders/${order.id}/dispatch`).set(a);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('dispatched_paid');
    expect(db.prepare('SELECT quantity FROM inventory WHERE product_id = ?').get(product.id).quantity).toBe(before - 1);
    const hist = db.prepare('SELECT to_status FROM order_status_history WHERE order_id = ? ORDER BY id').all(order.id).map((h) => h.to_status);
    expect(hist).toEqual(['awaiting_dispatch', 'dispatched_unpaid', 'dispatched_paid']);
    expect(db.prepare('SELECT method, amount FROM payment_records WHERE order_id = ?').get(order.id)).toMatchObject({ method: 'card', amount: 150000 });
  });

  it('a normal (unpaid) order still dispatches as unpaid - the new rule only affects already-paid ones', async () => {
    const created = await request(app).post('/api/orders').set(a).send({ name: 'Walk In', phone: '0722777001', payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] });
    const res = await request(app).post(`/api/orders/${created.body.data.id}/dispatch`).set(a);
    expect(res.body.data.status).toBe('dispatched_unpaid');
  });

  it('an item with no matching SKU imports, but dispatching it says exactly what is wrong (no stock)', async () => {
    const src = await newSource('Unknown SKU Shop');
    fetchSpy.mockResolvedValue([sOrder(9701, { line_items: [{ title: 'Mystery Gadget', sku: 'NOPE-1', quantity: 1, price: '500.00', total_discount: '0.00', tax_lines: [] }] })]);
    expect((await pull(src.id)).body.data.imported).toBe(1);
    const res = await request(app).post(`/api/orders/${orderBy(src.id, 9701).id}/dispatch`).set(a);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Insufficient stock');
  });
});

describe('cancellations on the store', () => {
  it('an order cancelled on Shopify while still waiting is cancelled here too; a dispatched one is left alone', async () => {
    const src = await newSource('Cancel Shop');
    fetchSpy.mockResolvedValue([sOrder(9801), sOrder(9802)]);
    await pull(src.id);
    await request(app).post(`/api/orders/${orderBy(src.id, 9802).id}/dispatch`).set(a);

    fetchSpy.mockResolvedValue([sOrder(9801, { cancelled_at: iso(0) }), sOrder(9802, { cancelled_at: iso(0) })]);
    const res = await pull(src.id);
    expect(res.body.data).toMatchObject({ cancelled: 1, skipped: 1 });
    expect(orderBy(src.id, 9801).status).toBe('cancelled');
    expect(orderBy(src.id, 9802).status).toBe('dispatched_paid');
  });
});

describe('revenue is never counted twice', () => {
  it('a linked order is excluded from the reports, because its sale is already counted', async () => {
    const src = await newSource('Report Shop');
    fetchSpy.mockResolvedValue([sOrder(9901, { line_items: [{ title: product.name, sku: product.sku, quantity: 1, price: '1500.00', total_discount: '0.00', tax_lines: [] }] })]);
    const range = `from=${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}&to=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`;
    const profit = async () => (await request(app).get(`/api/reports/profit-summary?${range}`).set(a)).body.data;
    const before = await profit();
    await pull(src.id);
    const order = orderBy(src.id, 9901);
    const afterPull = await profit();                       // sale counted (completed), order not yet dispatched
    await request(app).post(`/api/orders/${order.id}/dispatch`).set(a);
    const afterDispatch = await profit();                   // dispatching the linked order must NOT add revenue again
    expect(JSON.stringify(afterDispatch.revenue ?? afterDispatch)).toBe(JSON.stringify(afterPull.revenue ?? afterPull));
    expect(before).toBeTruthy();
  });

  it('a linked order is also excluded from the dashboard\'s "online sales today", but a normal (unlinked) order still counts', async () => {
    const dash = async () => (await request(app).get('/api/reports/dashboard-overview').set(a)).body.data.salesToday;
    const src = (await request(app).get('/api/orders/online-sources').set(a)).body.data[0];
    const baseline = await dash();

    // a LINKED Shopify order, paid and dispatched today
    fetchSpy.mockResolvedValue([sOrder(9951, { line_items: [{ title: product.name, sku: product.sku, quantity: 1, price: '1500.00', total_discount: '0.00', tax_lines: [] }] })]);
    await pull(src.id);
    await request(app).post(`/api/orders/${orderBy(src.id, 9951).id}/dispatch`).set(a);
    const afterLinked = await dash();
    expect(afterLinked.onlineRevenue).toBe(baseline.onlineRevenue);      // not counted a second time
    expect(afterLinked.onlineOrderCount).toBe(baseline.onlineOrderCount);

    // a plain POS-created online order, paid and dispatched today, counts as before
    const created = (await request(app).post('/api/orders').set(a).send({ name: 'Plain', phone: '0722888001', payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] })).body.data;
    await request(app).post(`/api/orders/${created.id}/dispatch`).set(a);
    await request(app).post(`/api/orders/${created.id}/payments`).set(a).send({ amount: created.total, method: 'cash' });
    const afterPlain = await dash();
    expect(afterPlain.onlineOrderCount).toBe(baseline.onlineOrderCount + 1);
    expect(afterPlain.onlineRevenue).toBe(baseline.onlineRevenue + created.total);
  });
});

describe('WooCommerce uses the same path', () => {
  it('imports a processing order as a "wordpress"-channel order and linked sale', async () => {
    const src = await newSource('Woo Shop', 'woocommerce');
    const wSpy = vi.spyOn(woocommerce, 'fetchOrders').mockResolvedValue([
      { id: 700, number: '700', status: 'processing', date_created: iso(1), date_paid: iso(1), payment_method: 'bacs', payment_method_title: 'Bank transfer',
        billing: { first_name: 'Joy', last_name: 'Mwangi', phone: '0733555001', email: 'j@x.com', city: 'Nairobi' }, shipping: { city: 'Nairobi' },
        line_items: [{ name: product.name, sku: product.sku, quantity: 2, subtotal: '3000.00', total: '2800.00', total_tax: '0' }], total: '2800.00' },
      { id: 701, number: '701', status: 'completed', date_created: iso(5), billing: { phone: '0733555002' }, line_items: [] },
    ]);
    const res = await pull(src.id);
    expect(res.body.data).toMatchObject({ imported: 1, ignored: 1 });
    const order = orderBy(src.id, 700);
    expect(order).toMatchObject({ channel: 'wordpress', payment_type: 'prepaid', subtotal: 300000, discount_total: 20000, total: 280000 });
    expect(order.sale_id).toBeTruthy();
    wSpy.mockRestore();
  });
});
