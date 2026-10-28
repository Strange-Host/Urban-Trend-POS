import { isIP } from 'node:net';
import type { Queryable } from '../db/tx.js';
import { getSecret, putSecret } from './secrets.js';
import { sourceProvider, type IncomeSource } from './sources.js';

// Calling Shopify and WooCommerce. Every call goes through an injectable fetch, so nothing here needs a real store to be tested.
export type StoreFetch = typeof fetch;

/** A store said no, or could not be reached. The message is written for the person who pressed the button. */
export class StoreError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

const TIMEOUT_MS = 20_000;
const MAX_PAGES = 400;           // a runaway Link header must not loop forever
export const DEFAULT_SHOPIFY_API_VERSION = '2026-01';
const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

// ---- where we are willing to send credentials ------------------------------------------------------------------------------
// A connection's address is typed in by an administrator, and what we send to it is a secret. So it must be what it claims to be: a
// Shopify shop under myshopify.com, or a public HTTPS site. This stops a mistyped or malicious address from pointing the server at
// its own network. (It checks the name; it does not defend against a DNS record that later points somewhere private.)
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function assertShopifyDomain(domain: string | null): string {
  const d = (domain ?? '').trim().toLowerCase();
  if (!SHOP_DOMAIN.test(d)) throw new StoreError('The Shopify shop address must look like your-shop.myshopify.com.');
  return d;
}

export function assertPublicHttps(raw: string | null): URL {
  const refuse = () => new StoreError('The WooCommerce site address must be a public https:// address.');
  let u: URL;
  try { u = new URL((raw ?? '').trim()); } catch { throw new StoreError('The WooCommerce site address is not a valid web address.'); }
  const host = u.hostname.toLowerCase();
  const bareIp = isIP(host) !== 0;                       // 1.2.3.4 (the URL parser also turns 2130706433 and 0x7f.1 into this form)
  const ipv6 = host.startsWith('[');                     // never a shop's public address
  const privateV4 = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(host);
  const internalName = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.');
  if (u.protocol !== 'https:') throw refuse();
  if (u.username || u.password) throw refuse();          // credentials in the address are never sent anywhere
  if (u.port && u.port !== '443') throw refuse();
  if (internalName || ipv6 || (bareIp && privateV4)) throw refuse();
  return u;
}

async function call(f: StoreFetch, url: string, init: RequestInit, what: string): Promise<Response> {
  let res: Response;
  try { res = await f(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (err) { throw new StoreError(`${what} could not be reached: ${err instanceof Error ? err.message : String(err)}`); }
  if (res.status >= 300 && res.status < 400) throw new StoreError(`${what} redirected the request, which is not followed (check the address).`, res.status);
  if (res.status === 401 || res.status === 403) throw new StoreError(`${what} refused access: check the credentials and that the app may read orders (Shopify read_orders, or a WooCommerce key with Read access).`, res.status);
  if (res.status === 404) throw new StoreError(`${what} does not have that address (check the shop address and API version).`, 404);
  if (res.status === 429) throw new StoreError(`${what} is rate limiting us; it will be tried again shortly.`, 429);
  if (!res.ok) throw new StoreError(`${what} answered HTTP ${res.status}.`, res.status);
  return res;
}

// ---- Shopify access tokens ---------------------------------------------------------------------------------------------------
// The app exchanges its own client id and secret for a token that lasts about 24 hours (client credentials grant). A token pasted in by
// hand has no expiry and is used as it is. The token is kept encrypted; only its expiry and scopes sit in the open.
const REFRESH_SKEW_MS = 60_000;

export async function shopifyToken(db: Queryable, masterKey: string | undefined, source: IncomeSource, f: StoreFetch, now = Date.now()): Promise<string> {
  const provider = sourceProvider(source.id);
  const cached = await getSecret(db, masterKey, provider, 'access_token');
  if (cached && (!source.tokenExpiresAt || source.tokenExpiresAt.getTime() - now > REFRESH_SKEW_MS)) return cached;

  const clientSecret = await getSecret(db, masterKey, provider, 'api_secret');
  if (!source.apiKey || !clientSecret) throw new StoreError(`"${source.name}" is not connected yet: it needs the shop address, the app's client id and its client secret.`);
  const shop = assertShopifyDomain(source.shopDomain);
  const res = await call(f, `https://${shop}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: source.apiKey, client_secret: clientSecret, grant_type: 'client_credentials' }).toString(),
  }, 'Shopify');
  const data = await res.json().catch(() => ({})) as { access_token?: string; scope?: string; expires_in?: number };
  if (!data.access_token) throw new StoreError('Shopify did not return an access token.');
  const expires = new Date(now + (data.expires_in || 86_399) * 1000);
  await putSecret(db, masterKey, { provider, name: 'access_token', value: data.access_token, actor: 'system' });
  await db.query(`UPDATE income_sources SET token_expires_at = $2, oauth_scopes = $3, updated_at = now() WHERE id = $1`, [source.id, expires, data.scope ?? '']);
  source.tokenExpiresAt = expires; source.oauthScopes = data.scope ?? '';
  return data.access_token;
}

export interface OrderFilter { createdSince?: Date; updatedSince?: Date }
export interface FetchOpts { paceMs?: number }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;

/** Every order matching the filter, following Shopify's Link-header cursor. Shopify shows an app only the last 60 days unless it has read_all_orders. */
export async function fetchShopifyOrders(source: IncomeSource, token: string, filter: OrderFilter, f: StoreFetch, opts: FetchOpts = {}): Promise<J[]> {
  const shop = assertShopifyDomain(source.shopDomain);
  const base = `https://${shop}/admin/api/${source.apiVersion || DEFAULT_SHOPIFY_API_VERSION}`;
  const params = ['limit=250', 'status=any'];
  if (filter.createdSince) params.push(`created_at_min=${encodeURIComponent(filter.createdSince.toISOString())}`);
  if (filter.updatedSince) params.push(`updated_at_min=${encodeURIComponent(filter.updatedSince.toISOString())}`);
  let url: string | null = `${base}/orders.json?${params.join('&')}`;
  const orders: J[] = [];
  for (let page = 0; url; page++) {
    if (page >= MAX_PAGES) throw new StoreError('Shopify returned more pages of orders than we are willing to read.');
    const res: Response = await call(f, url, { headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' } }, 'Shopify');
    const body = await res.json().catch(() => ({})) as { orders?: J[] };
    if (!Array.isArray(body.orders)) throw new StoreError('Shopify answered, but not with a list of orders.');
    orders.push(...body.orders);
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
    // The next page must be on the same shop: a Link header is not allowed to send our token somewhere else.
    if (next && new URL(next).hostname.toLowerCase() !== shop) throw new StoreError('Shopify pointed to a page on a different host; stopped.');
    url = next ?? null;
    if (url) await sleep(opts.paceMs ?? 550);
  }
  return orders;
}

/** Every order matching the filter, page by page (WooCommerce has no cursor: a short page is the last one). */
export async function fetchWooOrders(source: IncomeSource, consumerKey: string, consumerSecret: string, filter: OrderFilter, f: StoreFetch, opts: FetchOpts = {}): Promise<J[]> {
  const site = assertPublicHttps(source.siteUrl);
  const auth = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`;
  const orders: J[] = [];
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new StoreError('WooCommerce returned more pages of orders than we are willing to read.');
    const u = new URL(`${site.origin}${site.pathname.replace(/\/$/, '')}/wp-json/wc/v3/orders`);
    u.searchParams.set('per_page', '100'); u.searchParams.set('page', String(page)); u.searchParams.set('status', 'any');
    if (filter.createdSince) u.searchParams.set('after', filter.createdSince.toISOString());
    if (filter.updatedSince) u.searchParams.set('modified_after', filter.updatedSince.toISOString());
    const res = await call(f, u.toString(), { headers: { Authorization: auth, Accept: 'application/json' } }, 'WooCommerce');
    const body = await res.json().catch(() => null) as J[] | null;
    if (!Array.isArray(body)) throw new StoreError('WooCommerce answered, but not with a list of orders.');
    orders.push(...body);
    if (body.length < 100) return orders;
    await sleep(opts.paceMs ?? 300);
  }
}

export async function fetchSourceOrders(db: Queryable, masterKey: string | undefined, source: IncomeSource, filter: OrderFilter, f: StoreFetch, opts: FetchOpts = {}): Promise<J[]> {
  if (source.platform === 'shopify') return fetchShopifyOrders(source, await shopifyToken(db, masterKey, source, f), filter, f, opts);
  const provider = sourceProvider(source.id);
  const key = await getSecret(db, masterKey, provider, 'consumer_key');
  const secret = await getSecret(db, masterKey, provider, 'consumer_secret');
  if (!source.siteUrl || !key || !secret) throw new StoreError(`"${source.name}" is not connected yet: it needs the site address, the consumer key and the consumer secret.`);
  return fetchWooOrders(source, key, secret, filter, f, opts);
}
