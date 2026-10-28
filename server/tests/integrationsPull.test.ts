import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createProduct } from '../src/catalog/products.js';
import { hmacBase64, createSource, setSourceSecret, type IncomeSource } from '../src/integrations/sources.js';
import { pullOrders } from '../src/integrations/pullOrders.js';
import { putSecret } from '../src/integrations/secrets.js';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { createLogger } from '../src/logger.js';
import { getOrderTx } from '../src/orders/orders.js';
import { receiveStock } from '../src/stock/stock.js';
import { dispatch, KEY, makeEnv, type Env } from './orderHelpers.js';
import { loggedIn } from './authHelpers.js';
import { fakeFetch, fingerprint, json, shopifyOrder, wooOrder, type FakeFetch } from './storeHelpers.js';

const SECRETS_KEY = 'secrets-key-for-tests-0123456789abcdef-xyz';
const SHOP = 'urban-trends.myshopify.com';
const A = { actor: 'mona', role: 'manager' };
let env: Env;
beforeAll(async () => { env = await makeEnv(); });
afterAll(() => env.db.drop());

const q = async (sql: string, a: unknown[] = []) => (await env.db.pool.query(sql, a)).rows;
const count = async (table: string, where = 'true', a: unknown[] = []) => Number((await q(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, a))[0].n);
let n = 0;
async function stocked(units = 20) {
  const p = await createProduct(env.db.pool, { sku: `PL-${++n}`, name: `Pull item ${n}`, priceCents: 150_000, ...A });
  await receiveStock(env.db.pool, { productId: p.id, quantity: units, ...A });
  return p;
}
async function shopifySource(over: { shopDomain?: string } = {}): Promise<IncomeSource> {
  const s = await createSource(env.db.pool, { platform: 'shopify', name: `Shopify ${++n}`, shopDomain: over.shopDomain ?? SHOP, apiKey: 'client-id', liveSyncEnabled: true });
  await setSourceSecret(env.db.pool, SECRETS_KEY, s, 'client-secret', 'admin');
  return s;
}
async function wooSource(): Promise<IncomeSource> {
  const s = await createSource(env.db.pool, { platform: 'woocommerce', name: `Woo ${++n}`, siteUrl: 'https://shop.example.com', liveSyncEnabled: true });
  await setSourceSecret(env.db.pool, SECRETS_KEY, s, 'woo-whsec', 'admin');
  for (const [name, value] of [['consumer_key', 'ck_1'], ['consumer_secret', 'cs_1']] as const) await putSecret(env.db.pool, SECRETS_KEY, { provider: `source:${s.id}`, name, value, actor: 'admin' });
  return s;
}
/** A Shopify that hands out a token and then these orders. */
const shopifyStore = (orders: () => unknown[]): FakeFetch => fakeFetch((c) =>
  c.url.pathname === '/admin/oauth/access_token' ? json({ access_token: 'shpat_x', scope: 'read_orders', expires_in: 86_399 }) : json({ orders: orders() }));
const wooStore = (orders: () => unknown[]): FakeFetch => fakeFetch(() => json(orders()));
const ctx = (f: FakeFetch) => ({ pool: env.db.pool, logger: createLogger('silent'), refKey: KEY, secretsKey: SECRETS_KEY, fetch: f, paceMs: 0 });
const refOf = async (id: unknown) => (await q(`SELECT order_ref FROM online_orders WHERE external_order_id = $1`, [String(id)]))[0]?.order_ref as string | undefined;

describe('pulling orders on demand', () => {
  it('imports what is to ship, ignores what is done, keeps what cannot be taken, and flags what was paid online', async () => {
    const s = await shopifySource(); const p = await stocked();
    const toShip = shopifyOrder(p.sku);
    const fulfilled = shopifyOrder(p.sku, { fulfillment_status: 'fulfilled' });
    const noPhone = shopifyOrder(p.sku, { shipping_address: { name: 'No Phone' } });
    const prepaid = shopifyOrder(p.sku, { financial_status: 'paid', payment_gateway_names: ['shopify_payments'] });
    const unreadable = shopifyOrder(p.sku, { line_items: [{ sku: p.sku, title: 'x', quantity: 1, price: 'ask', total_discount: '0' }] });
    const f = shopifyStore(() => [toShip, fulfilled, noPhone, prepaid, unreadable]);

    const r = await pullOrders(ctx(f), s.id, { days: 30 });
    expect(r).toMatchObject({ found: 5, imported: 2, ignored: 1, needsReview: 2, needsAttention: 0, failed: 0, cancelled: 0, unchanged: 0 });
    expect(r.errors).toHaveLength(2);
    expect(await refOf(toShip.id)).toBeDefined();
    expect(await refOf(fulfilled.id)).toBeUndefined();
    expect(await q(`SELECT paid_online FROM online_orders WHERE external_order_id = $1`, [String(prepaid.id)])).toEqual([{ paid_online: true }]);
    expect(await count('webhook_events', `provider = 'shopify' AND status = 'malformed'`)).toBe(2);
    expect(await count('alerts', `kind = 'shopify_notice_unreadable' AND acknowledged_at IS NULL`)).toBe(1);
    expect(await count('alerts', `kind = 'online_order_paid_online' AND acknowledged_at IS NULL`)).toBe(1);
    // It asked for the window it was given, with the token it was issued.
    const orderCall = f.calls.find((c) => c.url.pathname.endsWith('/orders.json'))!;
    expect(orderCall.headers['X-Shopify-Access-Token']).toBe('shpat_x');
    expect(Date.parse(orderCall.url.searchParams.get('created_at_min')!)).toBeGreaterThan(Date.now() - 31 * 86_400_000);
  });

  it('pulling the same orders again changes nothing, anywhere, and raises no second alert', async () => {
    const s = await shopifySource(); const p = await stocked();
    const orders = [shopifyOrder(p.sku), shopifyOrder(p.sku, { shipping_address: { name: 'No Phone' } }), shopifyOrder(p.sku, { financial_status: 'paid', payment_gateway_names: ['stripe'] })];
    const f = shopifyStore(() => orders);
    await pullOrders(ctx(f), s.id);
    const after = await fingerprint(env.db.pool);
    for (let i = 0; i < 3; i++) {
      const again = await pullOrders(ctx(f), s.id);
      expect(again).toMatchObject({ found: 3, imported: 0, unchanged: 2, needsReview: 1 });
    }
    expect(await fingerprint(env.db.pool)).toEqual(after);
  });

  it('an order that arrived by webhook and then by pull is one order', async () => {
    const s = await shopifySource(); const p = await stocked(); const o = shopifyOrder(p.sku);
    const raw = JSON.stringify(o);
    const hook = await request(createApp({ pool: env.db.pool, logger: createLogger('silent'), orderRefKey: KEY, secretsKey: SECRETS_KEY }))
      .post(`/api/integrations/webhooks/shopify/${s.id}`).set('Content-Type', 'application/json').set('X-Shopify-Topic', 'orders/create').set('X-Shopify-Webhook-Id', `wh-${n++}`)
      .set('X-Shopify-Shop-Domain', SHOP).set('X-Shopify-Hmac-Sha256', hmacBase64('client-secret', Buffer.from(raw))).send(raw);
    expect(hook.body).toEqual({ status: 'processed' });
    const r = await pullOrders(ctx(shopifyStore(() => [o])), s.id);
    expect(r).toMatchObject({ found: 1, imported: 0, unchanged: 1 });
    expect(await count('online_orders', `external_order_id = $1`, [String(o.id)])).toBe(1);
  });

  it('a cancellation seen by pull cancels a waiting order, returns its stock, and is quiet the second time', async () => {
    const s = await shopifySource(); const p = await stocked(20); const o = shopifyOrder(p.sku);
    await pullOrders(ctx(shopifyStore(() => [o])), s.id);
    const ref = (await refOf(o.id))!;
    const cancelled = { ...o, cancelled_at: '2026-10-28T08:00:00Z' };
    expect(await pullOrders(ctx(shopifyStore(() => [cancelled])), s.id)).toMatchObject({ cancelled: 1 });
    expect((await getOrderTx(env.db.pool, ref))!.status).toBe('cancelled');
    const after = await fingerprint(env.db.pool);
    expect(await pullOrders(ctx(shopifyStore(() => [cancelled])), s.id)).toMatchObject({ cancelled: 0, unchanged: 1 });
    expect(await fingerprint(env.db.pool)).toEqual(after);
    expect((await runIntegrityChecks(env.db.pool)).ok).toBe(true);
  });

  it('an order cancelled on the store but already out for delivery is reported once, not undone, not repeated', async () => {
    const s = await shopifySource(); const p = await stocked(); const o = shopifyOrder(p.sku);
    await pullOrders(ctx(shopifyStore(() => [o])), s.id);
    const ref = (await refOf(o.id))!;
    await dispatch(env, ref);
    const cancelled = { ...o, cancelled_at: '2026-10-28T08:00:00Z' };
    const r = await pullOrders(ctx(shopifyStore(() => [cancelled])), s.id);
    expect(r).toMatchObject({ needsAttention: 1, cancelled: 0 });
    expect(r.errors[0]).toContain('already dispatched');
    const after = await fingerprint(env.db.pool);
    expect(await pullOrders(ctx(shopifyStore(() => [cancelled])), s.id)).toMatchObject({ needsAttention: 1 });
    expect(await fingerprint(env.db.pool)).toEqual(after);
    expect((await getOrderTx(env.db.pool, ref))!.status).toBe('dispatched');
  });

  it('WooCommerce orders come in the same way', async () => {
    const s = await wooSource(); const p = await stocked();
    const o = wooOrder(p.sku); const done = wooOrder(p.sku, { status: 'completed' });
    const f = wooStore(() => [o, done]);
    expect(await pullOrders(ctx(f), s.id)).toMatchObject({ found: 2, imported: 1, ignored: 1 });
    expect(f.calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('ck_1:cs_1').toString('base64')}`);
    expect(f.calls[0]!.url.searchParams.get('after')).toBeTruthy();
    expect((await getOrderTx(env.db.pool, (await refOf(o.id))!))!.totalCents).toBe(180_000);
  });

  it('says so, and changes nothing, when the connection is unknown, switched off, not set up, or the store is down', async () => {
    const f = shopifyStore(() => []);
    await expect(pullOrders(ctx(f), 987_654)).rejects.toMatchObject({ status: 404, code: 'SOURCE_NOT_FOUND' });
    const off = await shopifySource(); await q(`UPDATE income_sources SET is_active = false WHERE id = $1`, [off.id]);
    await expect(pullOrders(ctx(f), off.id)).rejects.toMatchObject({ status: 409, code: 'SOURCE_INACTIVE' });
    const bare = await createSource(env.db.pool, { platform: 'shopify', name: 'Bare', shopDomain: SHOP });
    await expect(pullOrders(ctx(f), bare.id)).rejects.toMatchObject({ status: 502, code: 'STORE_ERROR', message: expect.stringContaining('not connected yet') });
    const live = await shopifySource(); const before = await fingerprint(env.db.pool);
    await expect(pullOrders(ctx(fakeFetch(() => { throw new Error('ETIMEDOUT'); })), live.id)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('could not be reached') });
    await expect(pullOrders(ctx(fakeFetch(() => json({}, { status: 401 }))), live.id)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('refused access') });
    // Both failures happened at the very first request (the token), so nothing at all was written.
    expect(await fingerprint(env.db.pool)).toEqual(before);
  });

  it('a fault on our side is counted, not thrown, and the next pull finishes the job', async () => {
    const s = await shopifySource(); const p = await stocked(); const o = shopifyOrder(p.sku);
    const f = shopifyStore(() => [o]);
    await q(`ALTER TABLE online_orders RENAME TO online_orders_off`);
    let r;
    try { r = await pullOrders(ctx(f), s.id); } finally { await q(`ALTER TABLE online_orders_off RENAME TO online_orders`); }
    expect(r).toMatchObject({ found: 1, failed: 1, imported: 0 });
    expect(await refOf(o.id)).toBeUndefined();
    expect(await pullOrders(ctx(f), s.id)).toMatchObject({ imported: 1, failed: 0 });
    expect(await count('online_orders', `external_order_id = $1`, [String(o.id)])).toBe(1);
  });
});

describe('the Pull online orders button', () => {
  const appWith = (f: FakeFetch) => createApp({ pool: env.db.pool, logger: createLogger('silent'), orderRefKey: KEY, secretsKey: SECRETS_KEY, storeFetch: f });

  it('needs a login and the permission to pull', async () => {
    const f = shopifyStore(() => []);
    expect((await request(appWith(f)).get('/api/online-orders/connections')).status).toBe(401);
    expect((await request(appWith(f)).post('/api/online-orders/pull').send({ sourceId: 1 })).status).toBe(401);
    const cashier = await loggedIn(env.db.pool, 'cashier');
    expect((await request(appWith(f)).get('/api/online-orders/connections').set('Authorization', cashier.auth)).status).toBe(403);
    expect((await request(appWith(f)).post('/api/online-orders/pull').set('Authorization', cashier.auth).send({ sourceId: 1 })).status).toBe(403);
  });

  it('lists only connections that can be pulled from, with nothing secret in the answer', async () => {
    const ok = await shopifySource(); const woo = await wooSource();
    const unset = await createSource(env.db.pool, { platform: 'shopify', name: 'Not set up', shopDomain: SHOP });
    const admin = await loggedIn(env.db.pool, 'admin');
    const r = await request(appWith(shopifyStore(() => []))).get('/api/online-orders/connections').set('Authorization', admin.auth);
    expect(r.status).toBe(200);
    const ids = (r.body.connections as { id: number }[]).map((c) => c.id);
    expect(ids).toContain(ok.id); expect(ids).toContain(woo.id); expect(ids).not.toContain(unset.id);
    expect(Object.keys(r.body.connections[0]).sort()).toEqual(['id', 'name', 'platform']);
    expect(JSON.stringify(r.body)).not.toMatch(/secret|token|key/i);
  });

  it('pulls, answers with the counts, and is recorded in the audit trail', async () => {
    const s = await shopifySource(); const p = await stocked(); const o = shopifyOrder(p.sku);
    const admin = await loggedIn(env.db.pool, 'admin');
    const r = await request(appWith(shopifyStore(() => [o]))).post('/api/online-orders/pull').set('Authorization', admin.auth).send({ sourceId: s.id, days: 14 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ found: 1, imported: 1, failed: 0 });
    expect(await refOf(o.id)).toBeDefined();
    const a = await q(`SELECT actor, details FROM audit_log WHERE action = 'online_orders_pulled' AND entity_id = $1`, [String(s.id)]);
    expect(a[0]).toMatchObject({ actor: admin.username, details: expect.objectContaining({ days: 14, imported: 1 }) });
  });

  it('refuses a bad request, an unknown connection, and reports a store that says no', async () => {
    const admin = await loggedIn(env.db.pool, 'admin'); const app = appWith(shopifyStore(() => []));
    const post = (body: object) => request(app).post('/api/online-orders/pull').set('Authorization', admin.auth).send(body);
    expect((await post({})).status).toBe(422);
    expect((await post({ sourceId: 'x' })).status).toBe(422);
    const s = await shopifySource();
    expect((await post({ sourceId: s.id, days: 0 })).status).toBe(422);
    expect((await post({ sourceId: s.id, days: 9999 })).status).toBe(422);
    expect((await post({ sourceId: 424_242 })).status).toBe(404);
    const down = await request(appWith(fakeFetch(() => json({}, { status: 401 })))).post('/api/online-orders/pull').set('Authorization', admin.auth).send({ sourceId: s.id });
    expect(down.status).toBe(502);
    expect(down.body.error?.code ?? down.body.code).toBe('STORE_ERROR');
  });
});

describe('after all of it, the money rules still hold', () => {
  it('the integrity check is clean', async () => { expect((await runIntegrityChecks(env.db.pool)).ok).toBe(true); });
});
