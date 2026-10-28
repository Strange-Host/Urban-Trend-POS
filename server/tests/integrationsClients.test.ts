import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { putSecret } from '../src/integrations/secrets.js';
import { createSource, type IncomeSource } from '../src/integrations/sources.js';
import { assertPublicHttps, assertShopifyDomain, fetchShopifyOrders, fetchWooOrders, shopifyToken, StoreError } from '../src/integrations/storeClients.js';
import { makeEnv, type Env } from './orderHelpers.js';
import { fakeFetch, json } from './storeHelpers.js';

const KEY = 'secrets-key-for-tests-0123456789abcdef-xyz';
const SHOP = 'urban-trends.myshopify.com';
let env: Env;
beforeAll(async () => { env = await makeEnv(); });
afterAll(() => env.db.drop());
const q = async (sql: string, a: unknown[] = []) => (await env.db.pool.query(sql, a)).rows;

describe('where credentials may be sent', () => {
  it.each(['https://shop.example.com', 'https://shop.example.com/', 'https://shop.example.com/blog', 'https://shop.example.com:443', 'https://203.0.113.7'])('%s is fine', (u) => {
    expect(() => assertPublicHttps(u)).not.toThrow();
  });
  it.each([
    'http://shop.example.com', 'https://localhost', 'https://app.localhost', 'https://127.0.0.1', 'https://10.0.0.5', 'https://192.168.1.10', 'https://172.20.0.1',
    'https://169.254.169.254', 'https://100.64.0.1', 'https://0.0.0.0', 'https://[::1]', 'https://2130706433', 'https://0x7f.1', 'https://printer.local', 'https://db.internal',
    'https://intranet', 'https://user:pw@shop.example.com', 'https://shop.example.com:8443', 'ftp://shop.example.com', 'not a url', '',
  ])('%s is refused', (u) => { expect(() => assertPublicHttps(u)).toThrow(StoreError); });
  it('only a myshopify.com shop is a Shopify address', () => {
    expect(assertShopifyDomain(' Urban-Trends.MyShopify.com ')).toBe(SHOP);
    for (const bad of ['evil.com', 'urban.myshopify.com.evil.com', 'urban myshopify.com', '127.0.0.1', '', 'a.b.myshopify.com']) expect(() => assertShopifyDomain(bad)).toThrow(StoreError);
    expect(() => assertShopifyDomain(null)).toThrow(StoreError);
  });
});

describe('Shopify access tokens', () => {
  const store = (over: { shopDomain?: string; apiKey?: string } = {}) => createSource(env.db.pool, { platform: 'shopify', name: 'Tok', shopDomain: SHOP, apiKey: 'client-id-123', ...over });
  const secret = (s: IncomeSource, name: string, value: string) => putSecret(env.db.pool, KEY, { provider: `source:${s.id}`, name, value, actor: 'admin' });
  const exchange = () => fakeFetch((c) => (c.url.pathname === '/admin/oauth/access_token' ? json({ access_token: 'shpat_fresh', scope: 'read_orders,read_products', expires_in: 86_399 }) : json({}, { status: 404 })));

  it('exchanges the app\'s client id and secret for a token, keeps it encrypted, and reuses it', async () => {
    const s = await store(); await secret(s, 'api_secret', 'client-secret-xyz');
    const f = exchange(); const now = Date.now();
    expect(await shopifyToken(env.db.pool, KEY, s, f, now)).toBe('shpat_fresh');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.method).toBe('POST');
    expect(f.calls[0]!.url.toString()).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(new URLSearchParams(f.calls[0]!.body).get('grant_type')).toBe('client_credentials');
    expect(new URLSearchParams(f.calls[0]!.body).get('client_secret')).toBe('client-secret-xyz');
    expect(f.calls[0]!.url.toString()).not.toContain('client-secret-xyz');     // the secret travels in the body, never the address
    const stored = (await q(`SELECT ciphertext FROM integration_secrets WHERE provider = $1 AND name = 'access_token'`, [`source:${s.id}`]))[0].ciphertext as string;
    expect(stored).not.toContain('shpat_fresh');
    const row = (await q(`SELECT oauth_scopes, token_expires_at FROM income_sources WHERE id = $1`, [s.id]))[0];
    expect(row.oauth_scopes).toBe('read_orders,read_products');
    expect(new Date(row.token_expires_at).getTime()).toBeGreaterThan(now + 86_000_000);

    // A later call finds the cached token valid: no second request.
    const again = (await import('../src/integrations/sources.js')).getSource;
    const fresh = (await again(env.db.pool, s.id))!;
    expect(await shopifyToken(env.db.pool, KEY, fresh, f, now + 60_000)).toBe('shpat_fresh');
    expect(f.calls).toHaveLength(1);
    // Within a minute of expiry it is renewed.
    expect(await shopifyToken(env.db.pool, KEY, fresh, f, now + 86_399_000 - 30_000)).toBe('shpat_fresh');
    expect(f.calls).toHaveLength(2);
  });

  it('a token pasted in by hand, with no expiry, is used as it is', async () => {
    const s = await store({ apiKey: undefined }); await secret(s, 'access_token', 'shpat_manual');
    const f = exchange();
    expect(await shopifyToken(env.db.pool, KEY, s, f)).toBe('shpat_manual');
    expect(f.calls).toHaveLength(0);
  });

  it('says what is missing, and never calls the store, when it is not connected', async () => {
    const s = await store(); const f = exchange();
    await expect(shopifyToken(env.db.pool, KEY, s, f)).rejects.toThrow(/not connected yet/);
    const noKey = await store({ apiKey: undefined }); await secret(noKey, 'api_secret', 'x');
    await expect(shopifyToken(env.db.pool, KEY, noKey, f)).rejects.toThrow(/not connected yet/);
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a shop address that is not Shopify\'s, before sending the secret anywhere', async () => {
    const s = await store({ shopDomain: 'evil.example.com' }); await secret(s, 'api_secret', 'client-secret-xyz');
    const f = exchange();
    await expect(shopifyToken(env.db.pool, KEY, s, f)).rejects.toThrow(/myshopify\.com/);
    expect(f.calls).toHaveLength(0);
  });

  it('reports a store that refuses the credentials, or answers without a token', async () => {
    const s = await store(); await secret(s, 'api_secret', 'bad');
    await expect(shopifyToken(env.db.pool, KEY, s, fakeFetch(() => json({}, { status: 401 })))).rejects.toThrow(/refused access/);
    await expect(shopifyToken(env.db.pool, KEY, s, fakeFetch(() => json({ nothing: true })))).rejects.toThrow(/did not return an access token/);
  });
});

describe('fetching orders from Shopify', () => {
  const src = { shopDomain: SHOP, apiVersion: null } as IncomeSource;
  const page = (orders: unknown[], next?: string) => json({ orders }, next ? { headers: { link: `<${next}>; rel="next"` } } : {});

  it('follows the cursor, sends the token, and asks for the right window', async () => {
    const f = fakeFetch((c) => (c.url.searchParams.get('page_info') === 'p2' ? page([{ id: 3 }]) : page([{ id: 1 }, { id: 2 }], `https://${SHOP}/admin/api/2026-01/orders.json?limit=250&page_info=p2`)));
    const got = await fetchShopifyOrders(src, 'tok-1', { createdSince: new Date('2026-09-01T00:00:00Z'), updatedSince: new Date('2026-10-01T12:30:00Z') }, f, { paceMs: 0 });
    expect(got.map((o) => o.id)).toEqual([1, 2, 3]);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.headers['X-Shopify-Access-Token']).toBe('tok-1');
    expect(f.calls[0]!.url.searchParams.get('created_at_min')).toBe('2026-09-01T00:00:00.000Z');
    expect(f.calls[0]!.url.searchParams.get('updated_at_min')).toBe('2026-10-01T12:30:00.000Z');
    expect(f.calls[0]!.url.searchParams.get('status')).toBe('any');
    expect(f.calls[0]!.url.pathname).toBe('/admin/api/2026-01/orders.json');
  });

  it('will not follow a page link to another host, and so never sends the token there', async () => {
    const f = fakeFetch(() => page([{ id: 1 }], 'https://evil.example.com/steal?page_info=x'));
    await expect(fetchShopifyOrders(src, 'tok-1', {}, f, { paceMs: 0 })).rejects.toThrow(/different host/);
    expect(f.calls).toHaveLength(1);
  });

  it('turns a refusal, a missing address, a rate limit, a redirect and a broken reply into plain messages', async () => {
    const run = (status: number, headers: Record<string, string> = {}) => fetchShopifyOrders(src, 't', {}, fakeFetch(() => json({}, { status, headers })), { paceMs: 0 });
    await expect(run(401)).rejects.toThrow(/refused access.*read_orders/);
    await expect(run(403)).rejects.toThrow(/refused access/);
    await expect(run(404)).rejects.toThrow(/does not have that address/);
    await expect(run(429)).rejects.toThrow(/rate limiting/);
    await expect(run(302, { location: 'https://elsewhere.example.com' })).rejects.toThrow(/redirected/);
    await expect(run(500)).rejects.toThrow(/HTTP 500/);
    await expect(fetchShopifyOrders(src, 't', {}, fakeFetch(() => json({ not: 'orders' })), { paceMs: 0 })).rejects.toThrow(/not with a list/);
    await expect(fetchShopifyOrders(src, 't', {}, fakeFetch(() => { throw new Error('ECONNRESET'); }), { paceMs: 0 })).rejects.toThrow(/could not be reached: ECONNRESET/);
  });

  it('stops a store that never ends its pages', async () => {
    const f = fakeFetch(() => page([{ id: 1 }], `https://${SHOP}/admin/api/2026-01/orders.json?page_info=again`));
    await expect(fetchShopifyOrders(src, 't', {}, f, { paceMs: 0 })).rejects.toThrow(/more pages/);
    expect(f.calls.length).toBe(400);
  });
});

describe('fetching orders from WooCommerce', () => {
  const src = { siteUrl: 'https://shop.example.com/', name: 'Blog' } as IncomeSource;
  const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: from + i }));

  it('reads page after page until a short one, with the key and secret as basic auth', async () => {
    const f = fakeFetch((c) => { const p = Number(c.url.searchParams.get('page')); return json(p === 1 ? rows(1, 100) : p === 2 ? rows(101, 100) : rows(201, 7)); });
    const got = await fetchWooOrders(src, 'ck_key', 'cs_secret', { createdSince: new Date('2026-10-01T00:00:00Z'), updatedSince: new Date('2026-10-20T00:00:00Z') }, f, { paceMs: 0 });
    expect(got).toHaveLength(207);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('ck_key:cs_secret').toString('base64')}`);
    expect(f.calls[0]!.url.origin + f.calls[0]!.url.pathname).toBe('https://shop.example.com/wp-json/wc/v3/orders');
    expect(f.calls[0]!.url.searchParams.get('after')).toBe('2026-10-01T00:00:00.000Z');
    expect(f.calls[0]!.url.searchParams.get('modified_after')).toBe('2026-10-20T00:00:00.000Z');
    expect(f.calls[0]!.url.toString()).not.toContain('cs_secret');
  });

  it('keeps a site\'s sub-folder, refuses a private address before calling it, and reads error replies', async () => {
    const f = fakeFetch(() => json([]));
    await fetchWooOrders({ ...src, siteUrl: 'https://example.com/shop' } as IncomeSource, 'k', 's', {}, f, { paceMs: 0 });
    expect(f.calls[0]!.url.pathname).toBe('/shop/wp-json/wc/v3/orders');
    const g = fakeFetch(() => json([]));
    await expect(fetchWooOrders({ ...src, siteUrl: 'https://192.168.0.5' } as IncomeSource, 'k', 's', {}, g, { paceMs: 0 })).rejects.toThrow(/public https/);
    expect(g.calls).toHaveLength(0);
    await expect(fetchWooOrders(src, 'k', 's', {}, fakeFetch(() => json({}, { status: 401 })), { paceMs: 0 })).rejects.toThrow(/refused access/);
    await expect(fetchWooOrders(src, 'k', 's', {}, fakeFetch(() => json({ message: 'nope' })), { paceMs: 0 })).rejects.toThrow(/not with a list/);
  });
});
