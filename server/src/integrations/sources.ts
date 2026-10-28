import { createHmac } from 'node:crypto';
import type { Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { getSecret, putSecret, safeEqual } from './secrets.js';

export type Platform = 'shopify' | 'woocommerce';

export interface IncomeSource {
  id: number; platform: Platform; name: string; shopDomain: string | null;
  isActive: boolean; liveSyncEnabled: boolean; importOrders: boolean;
  siteUrl: string | null; apiKey: string | null; apiVersion: string | null; oauthScopes: string | null; tokenExpiresAt: Date | null;
  lastPollAt: Date | null; lastPollOkAt: Date | null; lastPollError: string | null;
}

interface Row {
  id: string; platform: Platform; name: string; shop_domain: string | null; is_active: boolean; live_sync_enabled: boolean; import_orders: boolean;
  site_url: string | null; api_key: string | null; api_version: string | null; oauth_scopes: string | null; token_expires_at: Date | null;
  last_poll_at: Date | null; last_poll_ok_at: Date | null; last_poll_error: string | null;
}
const COLUMNS = `id, platform, name, shop_domain, is_active, live_sync_enabled, import_orders, site_url, api_key, api_version, oauth_scopes, token_expires_at, last_poll_at, last_poll_ok_at, last_poll_error`;
const toSource = (r: Row): IncomeSource => ({
  id: Number(r.id), platform: r.platform, name: r.name, shopDomain: r.shop_domain, isActive: r.is_active, liveSyncEnabled: r.live_sync_enabled, importOrders: r.import_orders,
  siteUrl: r.site_url, apiKey: r.api_key, apiVersion: r.api_version, oauthScopes: r.oauth_scopes, tokenExpiresAt: r.token_expires_at,
  lastPollAt: r.last_poll_at, lastPollOkAt: r.last_poll_ok_at, lastPollError: r.last_poll_error,
});

export async function getSource(db: Queryable, id: number): Promise<IncomeSource | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM income_sources WHERE id = $1`, [id]);
  return rows[0] ? toSource(rows[0]) : null;
}

/**
 * Registers a connection. Pass `id` only when importing from the legacy system: webhook URLs already registered with the stores end in
 * that id, so it must be kept (the sequence is moved past it so new connections never collide).
 */
export async function createSource(db: Queryable, input: { platform: Platform; name: string; shopDomain?: string; siteUrl?: string; apiKey?: string; apiVersion?: string; liveSyncEnabled?: boolean; importOrders?: boolean; id?: number }): Promise<IncomeSource> {
  if (!input.name?.trim()) throw new HttpError(422, 'VALIDATION', 'A connection needs a name.');
  const { rows } = await db.query<Row>(
    `INSERT INTO income_sources (id, platform, name, shop_domain, site_url, api_key, api_version, live_sync_enabled, import_orders)
     VALUES (COALESCE($1::bigint, nextval(pg_get_serial_sequence('income_sources', 'id'))), $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${COLUMNS}`,
    [input.id ?? null, input.platform, input.name.trim(), input.shopDomain?.trim().toLowerCase() || null, input.siteUrl?.trim() || null, input.apiKey?.trim() || null, input.apiVersion?.trim() || null, input.liveSyncEnabled ?? false, input.importOrders ?? true]);
  if (input.id !== undefined) await db.query(`SELECT setval(pg_get_serial_sequence('income_sources', 'id'), GREATEST((SELECT max(id) FROM income_sources), 1))`);
  return toSource(rows[0]!);
}

/** Shopify signs with the app's client secret; WooCommerce with the secret set on the webhook. Both are kept encrypted. */
export const secretName = (platform: Platform) => (platform === 'shopify' ? 'api_secret' : 'webhook_secret');
export const sourceProvider = (id: number) => `source:${id}`;

export async function setSourceSecret(db: Queryable, masterKey: string | undefined, source: IncomeSource, value: string, actor: string): Promise<void> {
  await putSecret(db, masterKey, { provider: sourceProvider(source.id), name: secretName(source.platform), value, actor });
}

export const hmacBase64 = (secret: string, raw: Buffer): string => createHmac('sha256', secret).update(raw).digest('base64');

export type Verdict = { ok: true } | { ok: false; why: string };

/**
 * Is this delivery really from the store? Both platforms send base64(HMAC-SHA256(secret, exact bytes received)), so what is checked is
 * the raw body, not the parsed one. A missing secret, a missing header or a mismatch all fail; nothing is compared early.
 * Shopify also names the shop it came from; if the connection records a shop domain, they must agree.
 */
export async function verifyDelivery(db: Queryable, masterKey: string | undefined, source: IncomeSource, headers: Record<string, string | string[] | undefined>, raw: Buffer | undefined): Promise<Verdict> {
  const h = (n: string) => { const v = headers[n]; return (Array.isArray(v) ? v[0] : v) ?? ''; };
  const secret = await getSecret(db, masterKey, sourceProvider(source.id), secretName(source.platform));
  if (!secret) return { ok: false, why: 'no secret is stored for this connection' };
  const signature = h(source.platform === 'shopify' ? 'x-shopify-hmac-sha256' : 'x-wc-webhook-signature');
  const body = raw ?? Buffer.alloc(0);
  const matches = signature.length > 0 && safeEqual(hmacBase64(secret, body), signature);
  if (!matches) return { ok: false, why: 'the signature does not match' };
  if (source.platform === 'shopify' && source.shopDomain) {
    const shop = h('x-shopify-shop-domain').toLowerCase();
    if (shop && shop !== source.shopDomain.toLowerCase()) return { ok: false, why: 'the delivery names a different shop' };
  }
  return { ok: true };
}
