import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createProduct, getProduct } from '../src/catalog/products.js';
import { moneyToCents, normalizeShopify, normalizeWoo } from '../src/integrations/onlineOrders.js';
import { createSource, hmacBase64, setSourceSecret, verifyDelivery, type IncomeSource } from '../src/integrations/sources.js';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { createLogger } from '../src/logger.js';
import { getOrderTx } from '../src/orders/orders.js';
import { ingestPaybillPayment } from '../src/orders/payments.js';
import { receiveStock } from '../src/stock/stock.js';
import { dispatch, freshPhone, KEY, makeEnv, type Env } from './orderHelpers.js';

const SECRETS_KEY = 'secrets-key-for-tests-0123456789abcdef-xyz';
const SHOPIFY_SECRET = 'shpss_client_secret_for_tests';
const WOO_SECRET = 'woo-webhook-secret-for-tests';
const A = { actor: 'mona', role: 'manager' };

let env: Env; let shop: IncomeSource; let woo: IncomeSource;
beforeAll(async () => {
  env = await makeEnv();
  shop = await createSource(env.db.pool, { platform: 'shopify', name: 'Main Shopify', shopDomain: 'Urban-Trends.myshopify.com', liveSyncEnabled: true });
  woo = await createSource(env.db.pool, { platform: 'woocommerce', name: 'Blog shop', liveSyncEnabled: true });
  await setSourceSecret(env.db.pool, SECRETS_KEY, shop, SHOPIFY_SECRET, 'admin');
  await setSourceSecret(env.db.pool, SECRETS_KEY, woo, WOO_SECRET, 'admin');
});
afterAll(() => env.db.drop());

const app = () => createApp({ pool: env.db.pool, logger: createLogger('silent'), orderRefKey: KEY, secretsKey: SECRETS_KEY });
const q = async (sql: string, args: unknown[] = []) => (await env.db.pool.query(sql, args)).rows;
const count = async (table: string, where = 'true', args: unknown[] = []) => Number((await q(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, args))[0].n);

async function fingerprint(): Promise<Record<string, string>> {
  const tables = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`);
  const out: Record<string, string> = {};
  for (const { table_name: t } of tables) out[t] = (await q(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`))[0].h;
  return out;
}

let n = 0;
type J = Record<string, unknown>;
async function stocked(units = 10, price = 150_000) {
  const p = await createProduct(env.db.pool, { sku: `ON-${++n}`, name: `Online item ${n}`, priceCents: price, ...A });
  await receiveStock(env.db.pool, { productId: p.id, quantity: units, ...A });
  return p;
}

const shopifyOrder = (sku: string, over: J = {}): J => ({
  id: 5_000_000 + n++, name: `#${1000 + n}`, order_number: 1000 + n, financial_status: 'pending', fulfillment_status: null, cancelled_at: null,
  payment_gateway_names: ['Cash on Delivery (COD)'], email: 'amina@example.com', note: null,
  shipping_address: { name: 'Amina K', phone: freshPhone(), city: 'Nairobi' },
  line_items: [{ sku, title: 'Online item', quantity: 2, price: '1500.00', total_discount: '0.00' }], ...over,
});
const wooOrder = (sku: string, over: J = {}): J => ({
  id: 9_000 + n++, number: String(9_000 + n), status: 'processing', payment_method: 'cod', payment_method_title: 'Cash on delivery', date_paid: null, customer_note: '',
  billing: { first_name: 'Otieno', last_name: 'B', phone: freshPhone(), email: 'o@example.com', city: 'Kisumu' }, shipping: { first_name: 'Otieno', last_name: 'B', city: 'Kisumu' },
  line_items: [{ sku, name: 'Woo item', quantity: 2, subtotal: '2000.00', total: '1800.00' }], ...over,
});

interface Opts { id?: string; secret?: string; source?: IncomeSource; shopDomain?: string; sign?: boolean }
const deliver = (platform: 'shopify' | 'woocommerce', topic: string, payload: unknown, o: Opts = {}) => {
  const source = o.source ?? (platform === 'shopify' ? shop : woo);
  const raw = JSON.stringify(payload);
  const sig = hmacBase64(o.secret ?? (platform === 'shopify' ? SHOPIFY_SECRET : WOO_SECRET), Buffer.from(raw));
  const r = request(app()).post(`/api/integrations/webhooks/${platform}/${source.id}`).set('Content-Type', 'application/json');
  if (platform === 'shopify') {
    r.set('X-Shopify-Topic', topic).set('X-Shopify-Webhook-Id', o.id ?? `wh-${n++}`).set('X-Shopify-Shop-Domain', o.shopDomain ?? 'urban-trends.myshopify.com');
    if (o.sign !== false) r.set('X-Shopify-Hmac-Sha256', sig);
  } else {
    r.set('X-WC-Webhook-Topic', topic).set('X-WC-Webhook-Delivery-ID', o.id ?? `wc-${n++}`);
    if (o.sign !== false) r.set('X-WC-Webhook-Signature', sig);
  }
  return r.send(raw);
};
const orderRefFor = async (externalId: unknown) => (await q(`SELECT order_ref FROM online_orders WHERE external_order_id = $1`, [String(externalId)]))[0]?.order_ref as string | undefined;

describe('reading store orders', () => {
  it.each([['1500.00', 150_000], ['1,500', 150_000], [1500.5, 150_050], ['', 0], [null, 0], ['0.00', 0], ['19.999', 2_000]])('%j is %i cents', (v, c) => { expect(moneyToCents(v)).toBe(c); });
  it.each([['abc'], ['-5'], ['1e3'], ['12 KES']])('%j is refused', (v) => { expect(moneyToCents(v)).toBeNull(); });

  it('maps a Shopify order, and a WooCommerce order, to the same shape', () => {
    const s = normalizeShopify({ ...shopifyOrder('X'), financial_status: 'paid', payment_gateway_names: ['shopify_payments'], line_items: [{ sku: 'X', title: 'T', quantity: 3, price: '100.50', total_discount: '10.00' }] });
    expect(s).toMatchObject({ toShip: true, paid: true, gateway: 'shopify_payments', lines: [{ sku: 'X', quantity: 3, unitPriceCents: 10_050, discountCents: 1_000 }], customer: { name: 'Amina K' } });
    const w = normalizeWoo(wooOrder('X'));
    expect(w).toMatchObject({ toShip: true, paid: false, lines: [{ sku: 'X', quantity: 2, unitPriceCents: 100_000, discountCents: 20_000 }], customer: { name: 'Otieno B' } });
    expect(normalizeWoo({ ...wooOrder('X'), status: 'refunded' }).cancelled).toBe(true);
    expect(normalizeShopify({ ...shopifyOrder('X'), line_items: [{ sku: 'X', title: 'T', quantity: 1, price: 'free', total_discount: '0' }] }).problem).toContain('could not be read');
  });
});

describe('is it really the store?', () => {
  const headers = (sig: string, shopDomain = 'urban-trends.myshopify.com') => ({ 'x-shopify-hmac-sha256': sig, 'x-shopify-shop-domain': shopDomain });
  const raw = Buffer.from('{"id":1}');
  it('accepts the right signature over the exact bytes, and nothing else', async () => {
    const good = hmacBase64(SHOPIFY_SECRET, raw);
    const check = (h: Record<string, string>, body: Buffer | undefined = raw) => verifyDelivery(env.db.pool, SECRETS_KEY, shop, h, body);
    expect((await check(headers(good))).ok).toBe(true);
    expect((await check(headers(good), Buffer.from('{"id":1} ')) ).ok).toBe(false);          // one byte different
    expect((await check(headers(hmacBase64('wrong-secret', raw)))).ok).toBe(false);
    expect((await check({})).ok).toBe(false);                                                // no signature at all
    expect((await check(headers(good, 'someone-else.myshopify.com'))).ok).toBe(false);      // right secret, wrong shop
    expect((await verifyDelivery(env.db.pool, undefined, shop, headers(good), raw)).ok).toBe(false); // no key to open the secret with
    expect((await verifyDelivery(env.db.pool, SECRETS_KEY, shop, headers(good), undefined)).ok).toBe(false); // no body at all
  });
  it('a connection with no secret stored refuses everything', async () => {
    const bare = await createSource(env.db.pool, { platform: 'woocommerce', name: 'No secret yet', liveSyncEnabled: true });
    expect((await verifyDelivery(env.db.pool, SECRETS_KEY, bare, { 'x-wc-webhook-signature': createHmac('sha256', '').update(raw).digest('base64') }, raw)).ok).toBe(false);
  });
});

describe('the webhook address', () => {
  it('a bad signature, an unknown connection and the wrong platform all get the same refusal, and change nothing', async () => {
    const p = await stocked(); const before = await fingerprint();
    const o = shopifyOrder(p.sku);
    const bad = await deliver('shopify', 'orders/create', o, { secret: 'not-the-secret' });
    const unsigned = await deliver('shopify', 'orders/create', o, { sign: false });
    const unknown = await deliver('shopify', 'orders/create', o, { source: { ...shop, id: 99_999 } });
    const wrongPlatform = await deliver('shopify', 'orders/create', o, { source: woo });
    for (const r of [bad, unsigned, unknown, wrongPlatform]) { expect(r.status).toBe(401); expect(r.body).toEqual({ error: 'Invalid signature.' }); }
    expect(await fingerprint()).toEqual(before);
  });

  it('needs no login, and the rest of the API still does', async () => {
    expect((await request(app()).get('/api/orders')).status).toBe(401);
  });

  it('a switched-off connection, or live sync off, is acknowledged and ignored', async () => {
    const p = await stocked();
    const off = await createSource(env.db.pool, { platform: 'shopify', name: 'Off', liveSyncEnabled: false });
    await setSourceSecret(env.db.pool, SECRETS_KEY, off, SHOPIFY_SECRET, 'admin');
    const before = await count('orders');
    const r = await deliver('shopify', 'orders/create', shopifyOrder(p.sku), { source: off, shopDomain: '' });
    expect(r.status).toBe(200); expect(r.body).toEqual({ status: 'ignored' });
    expect(await count('orders')).toBe(before);
  });
});

describe('Shopify: an order arrives', () => {
  it('becomes an order here, reserves stock, and is linked to its store order', async () => {
    const p = await stocked(10);
    const o = shopifyOrder(p.sku);
    const r = await deliver('shopify', 'orders/create', o);
    expect(r.status).toBe(200); expect(r.body).toEqual({ status: 'processed' });
    const ref = (await orderRefFor(o.id))!;
    const order = (await getOrderTx(env.db.pool, ref))!;
    expect(order).toMatchObject({ status: 'awaiting_dispatch', totalCents: 300_000, paidCents: 0 });
    expect(await getProduct(env.db.pool, p.id)).toMatchObject({ onHand: 10, reserved: 2, available: 8 });
    expect((await q(`SELECT created_by, notes FROM orders WHERE order_ref = $1`, [ref]))[0]).toMatchObject({ created_by: 'shopify', notes: expect.stringContaining(`Imported from Shopify order ${o.name}`) });
    expect(await count('order_events', `order_ref = $1 AND type = 'imported_online'`, [ref])).toBe(1);
    expect(await q(`SELECT paid_online FROM online_orders WHERE order_ref = $1`, [ref])).toEqual([{ paid_online: false }]);
  });

  it('the same delivery sent again and again changes nothing, anywhere', async () => {
    const p = await stocked(); const o = shopifyOrder(p.sku);
    expect((await deliver('shopify', 'orders/create', o, { id: 'wh-replay-1' })).status).toBe(200);
    const after = await fingerprint();
    for (let i = 0; i < 4; i++) {
      const again = await deliver('shopify', 'orders/create', o, { id: 'wh-replay-1' });
      expect(again.status).toBe(200); expect(again.body).toEqual({ status: 'duplicate' });
    }
    expect(await fingerprint()).toEqual(after);
  });

  it('"created" and then "updated" (different deliveries) are one order; so are six at the same instant', async () => {
    const p = await stocked(); const o = shopifyOrder(p.sku);
    await deliver('shopify', 'orders/create', o);
    await deliver('shopify', 'orders/updated', { ...o, note: 'call before delivery' });
    expect(await count('online_orders', `external_order_id = $1`, [String(o.id)])).toBe(1);

    const p2 = await stocked(); const o2 = shopifyOrder(p2.sku);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => deliver('shopify', i % 2 ? 'orders/create' : 'orders/updated', o2)));
    expect(results.map((x) => x.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await count('online_orders', `external_order_id = $1`, [String(o2.id)])).toBe(1);
    expect(await count('orders', `phone_normalized = $1`, [String((o2.shipping_address as J).phone).slice(-9)])).toBe(1);
    expect(await getProduct(env.db.pool, p2.id)).toMatchObject({ reserved: 2 });
  });

  it('an order already fulfilled on the store is not work here', async () => {
    const p = await stocked(); const before = await count('orders');
    const r = await deliver('shopify', 'orders/create', shopifyOrder(p.sku, { fulfillment_status: 'fulfilled' }));
    expect(r.body).toEqual({ status: 'ignored' });
    expect(await count('orders')).toBe(before);
  });

  it('a large delivery (a store sends whole orders) is accepted', async () => {
    const p = await stocked();
    const r = await deliver('shopify', 'orders/create', { ...shopifyOrder(p.sku), tags: 'x'.repeat(1_500_000) });
    expect(r.status).toBe(200); expect(r.body).toEqual({ status: 'processed' });
  });

  it('paid on the store: imported, flagged, with one alert, so nobody asks the customer to pay twice', async () => {
    const p = await stocked(); const o = shopifyOrder(p.sku, { financial_status: 'paid', payment_gateway_names: ['shopify_payments'] });
    expect((await deliver('shopify', 'orders/create', o)).body).toEqual({ status: 'processed' });
    const ref = (await orderRefFor(o.id))!;
    expect(await q(`SELECT paid_online, gateway FROM online_orders WHERE order_ref = $1`, [ref])).toEqual([{ paid_online: true, gateway: 'shopify_payments' }]);
    expect((await q(`SELECT notes FROM orders WHERE order_ref = $1`, [ref]))[0].notes).toContain('PAID ONLINE');
    expect(await count('alerts', `kind = 'online_order_paid_online' AND acknowledged_at IS NULL`)).toBe(1);
  });
});

describe('Shopify: an order that cannot be taken as it stands is kept for a person, not lost', () => {
  const kept = (substr: string) => count('webhook_events', `provider = 'shopify' AND status = 'malformed' AND error LIKE $1`, [`%${substr}%`]);

  it.each([
    ['no phone number', (sku: string) => shopifyOrder(sku, { shipping_address: { name: 'No Phone', city: 'Nairobi' } }), 'ONLINE_ORDER_NO_PHONE'],
    ['more than is in stock', (sku: string) => shopifyOrder(sku, { line_items: [{ sku, title: 'x', quantity: 500, price: '10.00', total_discount: '0' }] }), 'INSUFFICIENT_STOCK'],
    ['an amount that cannot be read', (sku: string) => shopifyOrder(sku, { line_items: [{ sku, title: 'x', quantity: 1, price: 'ask us', total_discount: '0' }] }), 'ONLINE_ORDER_UNREADABLE'],
    ['no items', (sku: string) => shopifyOrder(sku, { line_items: [] }), 'ONLINE_ORDER_NO_ITEMS'],
  ])('%s', async (_name, build, code) => {
    const p = await stocked(); const o = build(p.sku); const before = await count('orders');
    const r = await deliver('shopify', 'orders/create', o, { id: `wh-bad-${code}` });
    expect(r.status).toBe(200); expect(r.body).toEqual({ status: 'needs_review' });
    expect(await count('orders')).toBe(before);
    expect(await kept(code)).toBe(1);
    expect(await count('alerts', `kind = 'shopify_notice_unreadable' AND acknowledged_at IS NULL`)).toBe(1);
    const after = await fingerprint();
    expect((await deliver('shopify', 'orders/create', o, { id: `wh-bad-${code}` })).body).toEqual({ status: 'duplicate' });
    expect(await fingerprint()).toEqual(after);
  });

  it('a phone that already has an active order is kept for a person to merge', async () => {
    const p = await stocked(); const o1 = shopifyOrder(p.sku);
    await deliver('shopify', 'orders/create', o1);
    const o2 = shopifyOrder(p.sku, { shipping_address: o1.shipping_address });
    expect((await deliver('shopify', 'orders/create', o2)).body).toEqual({ status: 'needs_review' });
    expect(await kept('DUPLICATE_ACTIVE_ORDER')).toBe(1);
    expect(await orderRefFor(o2.id)).toBeUndefined();
  });

  it('in strict stock mode an unknown product code is kept for review too', async () => {
    await q(`INSERT INTO settings (key, value) VALUES ('stock.strict', 'true') ON CONFLICT (key) DO UPDATE SET value = 'true'`);
    try {
      const o = shopifyOrder('NOT-IN-CATALOG');
      expect((await deliver('shopify', 'orders/create', o)).body).toEqual({ status: 'needs_review' });
      expect(await kept('UNKNOWN_PRODUCT')).toBe(1);
    } finally { await q(`UPDATE settings SET value = 'false' WHERE key = 'stock.strict'`); }
  });
});

describe('Shopify: an order is cancelled on the store', () => {
  it('a waiting order is cancelled here too, the stock comes back, the ledger reverses, and a replay changes nothing', async () => {
    const p = await stocked(10); const o = shopifyOrder(p.sku);
    await deliver('shopify', 'orders/create', o);
    expect(await getProduct(env.db.pool, p.id)).toMatchObject({ reserved: 2 });
    const cancelled = { ...o, cancelled_at: '2026-10-28T10:00:00Z' };
    const r = await deliver('shopify', 'orders/cancelled', cancelled, { id: 'wh-cancel-1' });
    expect(r.body).toEqual({ status: 'processed' });
    const ref = (await orderRefFor(o.id))!;
    expect((await getOrderTx(env.db.pool, ref))!.status).toBe('cancelled');
    expect(await getProduct(env.db.pool, p.id)).toMatchObject({ onHand: 10, reserved: 0, available: 10 });
    const after = await fingerprint();
    for (let i = 0; i < 3; i++) expect((await deliver('shopify', 'orders/cancelled', cancelled, { id: 'wh-cancel-1' })).body).toEqual({ status: 'duplicate' });
    expect(await fingerprint()).toEqual(after);
    expect((await deliver('shopify', 'orders/cancelled', cancelled)).body).toEqual({ status: 'ignored' }); // a different delivery of the same cancellation
    expect(await count('online_orders', `order_ref = $1`, [ref])).toBe(1);
    expect((await runIntegrityChecks(env.db.pool)).ok).toBe(true);
  });

  it('copies of the cancellation at the same instant cancel it once', async () => {
    const p = await stocked(); const o = shopifyOrder(p.sku);
    await deliver('shopify', 'orders/create', o);
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver('shopify', 'orders/cancelled', { ...o, cancelled_at: '2026-10-28T10:00:00Z' })));
    expect(results.map((x) => x.status)).toEqual([200, 200, 200, 200, 200]);
    const ref = (await orderRefFor(o.id))!;
    expect(await count('order_events', `order_ref = $1 AND type = 'cancelled'`, [ref])).toBe(1);
    expect((await getOrderTx(env.db.pool, ref))!.status).toBe('cancelled');
  });

  it('an order with money already on it is NOT cancelled behind anyone\'s back: a person is told', async () => {
    const p = await stocked(); const o = shopifyOrder(p.sku);
    await deliver('shopify', 'orders/create', o);
    const ref = (await orderRefFor(o.id))!;
    await ingestPaybillPayment({ pool: env.db.pool }, { transCode: `SKPAY${n++}00001`.slice(0, 12), amountCents: 100_000, accountRef: ref });
    const r = await deliver('shopify', 'orders/cancelled', { ...o, cancelled_at: '2026-10-28T10:00:00Z' });
    expect(r.status).toBe(200);
    expect((await getOrderTx(env.db.pool, ref))!.status).toBe('awaiting_dispatch');
    expect(await count('alerts', `kind = 'online_order_needs_attention' AND acknowledged_at IS NULL`)).toBeGreaterThanOrEqual(1);
  });

  it('an order that has already gone out is reported, not undone', async () => {
    const p = await stocked(); const o = shopifyOrder(p.sku);
    await deliver('shopify', 'orders/create', o);
    const ref = (await orderRefFor(o.id))!;
    await dispatch(env, ref);
    const r = await deliver('shopify', 'orders/cancelled', { ...o, cancelled_at: '2026-10-28T10:00:00Z' });
    expect(r.status).toBe(200);
    expect((await getOrderTx(env.db.pool, ref))!.status).toBe('dispatched');
    const ev = await q(`SELECT result FROM webhook_events WHERE provider = 'shopify' AND kind = 'orders/cancelled' ORDER BY id DESC LIMIT 1`);
    expect(ev[0].result).toMatchObject({ action: 'needs_attention', orderRef: ref });
  });

  it('a cancellation for an order never imported is ignored', async () => {
    const p = await stocked(); const before = await count('orders');
    const r = await deliver('shopify', 'orders/cancelled', { ...shopifyOrder(p.sku), cancelled_at: '2026-10-28T10:00:00Z' });
    expect(r.body).toEqual({ status: 'ignored' });
    expect(await count('orders')).toBe(before);
  });
});

describe('WooCommerce', () => {
  it('the unsigned form-encoded ping when a webhook is created gets a 200', async () => {
    const before = await fingerprint();
    const r = await request(app()).post(`/api/integrations/webhooks/woocommerce/${woo.id}`).type('form').send({ webhook_id: '42' });
    expect(r.status).toBe(200); expect(r.body).toEqual({ status: 'pong' });
    expect(await fingerprint()).toEqual(before);
  });

  it('an unsigned body that is not the ping is refused', async () => {
    const r = await request(app()).post(`/api/integrations/webhooks/woocommerce/${woo.id}`).type('form').send({ id: '7', status: 'processing' });
    expect(r.status).toBe(401);
  });

  it('an order becomes an order here, with its discount, and replays change nothing', async () => {
    const p = await stocked(10, 100_000); const o = wooOrder(p.sku);
    const r = await deliver('woocommerce', 'order.created', o, { id: 'wc-1' });
    expect(r.body).toEqual({ status: 'processed' });
    const ref = (await orderRefFor(o.id))!;
    expect(await getOrderTx(env.db.pool, ref)).toMatchObject({ status: 'awaiting_dispatch', totalCents: 180_000 }); // 2 x 1000.00, less 200.00 off
    expect(await getProduct(env.db.pool, p.id)).toMatchObject({ reserved: 2 });
    expect((await q(`SELECT created_by FROM orders WHERE order_ref = $1`, [ref]))[0].created_by).toBe('woocommerce');
    const after = await fingerprint();
    for (let i = 0; i < 3; i++) expect((await deliver('woocommerce', 'order.created', o, { id: 'wc-1' })).body).toEqual({ status: 'duplicate' });
    expect(await fingerprint()).toEqual(after);
  });

  it('a deleted order (which carries only its id) cancels a waiting one', async () => {
    const p = await stocked(); const o = wooOrder(p.sku);
    await deliver('woocommerce', 'order.created', o);
    const r = await deliver('woocommerce', 'order.deleted', { id: o.id });
    expect(r.body).toEqual({ status: 'processed' });
    expect((await getOrderTx(env.db.pool, (await orderRefFor(o.id))!))!.status).toBe('cancelled');
  });

  it('a refunded or cancelled status cancels it, and a paid-online order is flagged', async () => {
    const p = await stocked(); const o = wooOrder(p.sku, { payment_method: 'stripe', payment_method_title: 'Card', date_paid: '2026-10-28T09:00:00' });
    await deliver('woocommerce', 'order.created', o);
    expect(await q(`SELECT paid_online FROM online_orders WHERE external_order_id = $1`, [String(o.id)])).toEqual([{ paid_online: true }]);
    await deliver('woocommerce', 'order.updated', { ...o, status: 'cancelled' });
    expect((await getOrderTx(env.db.pool, (await orderRefFor(o.id))!))!.status).toBe('cancelled');
  });
});

describe('products and other topics', () => {
  it('product changes are acknowledged and ignored for now, once, with nothing else changing', async () => {
    const before = await count('products');
    const r = await deliver('shopify', 'products/update', { id: 123, title: 'Thing' });
    expect(r.status).toBe(200); expect(r.body).toEqual({ status: 'ignored' });
    expect(await count('products')).toBe(before);
    expect((await deliver('shopify', 'customers/create', { id: 1 })).body).toEqual({ status: 'ignored' });
  });
});

describe('a fault on our side asks the store to try again', () => {
  it('answers 500 while the database cannot finish; the retry that succeeds makes exactly one order', async () => {
    const p = await stocked(); const o = shopifyOrder(p.sku);
    await q(`ALTER TABLE online_orders RENAME TO online_orders_off`);
    let failed;
    try { failed = await deliver('shopify', 'orders/create', o, { id: 'wh-retry-1' }); } finally { await q(`ALTER TABLE online_orders_off RENAME TO online_orders`); }
    expect(failed.status).toBe(500); expect(failed.body).toEqual({ status: 'retry' });
    expect(await count('webhook_events', `provider = 'shopify' AND status = 'failed'`)).toBe(1);
    expect(await count('orders', `phone_normalized = $1`, [String((o.shipping_address as J).phone).slice(-9)])).toBe(0); // nothing half-made

    expect((await deliver('shopify', 'orders/create', o, { id: 'wh-retry-1' })).body).toEqual({ status: 'processed' });
    expect(await count('webhook_events', `provider = 'shopify' AND status = 'failed'`)).toBe(0);
    expect(await count('online_orders', `external_order_id = $1`, [String(o.id)])).toBe(1);
  });
});

describe('after all of it, the money rules still hold', () => {
  it('the integrity check is clean', async () => {
    expect((await runIntegrityChecks(env.db.pool)).ok).toBe(true);
  });
});
