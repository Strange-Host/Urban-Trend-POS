const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const shopify = require('../config/shopify');
const woocommerce = require('../config/woocommerce');
const shopifyOAuth = require('./shopifyOAuth.service');
const { fromUpstreamError } = require('../utils/upstreamError');
const { encrypt, decrypt } = require('../utils/crypto');

// Columns holding third-party secrets — encrypted at rest (see utils/crypto.js).
const ENCRYPTED_FIELDS = ['api_secret', 'access_token', 'consumer_key', 'consumer_secret', 'webhook_secret'];

// People very naturally paste these straight from a browser address bar —
// "https://xyz.myshopify.com/admin" or with a trailing slash — which would
// otherwise silently build a broken URL (https://https://xyz...) at request
// time with a confusing DNS-ish error, instead of a clear validation message
// up front. Strips protocol, any path, trailing slash, and whitespace.
function normalizeDomainOrUrl(value) {
  if (!value) return null;
  let v = value.trim().replace(/^https?:\/\//i, '');
  v = v.split('/')[0]; // drop any path/query that came along for the ride
  return v.replace(/\/+$/, '') || null;
}
function normalizeSiteUrl(value) {
  if (!value) return null;
  const host = value.trim().replace(/^https?:\/\//i, '').split('/')[0];
  if (!host) return null;
  return `https://${host}`.replace(/\/+$/, '');
}

const SAFE_FIELDS = `
  id, name, platform, store_id, is_active,
  shop_domain, api_key, api_version, oauth_scopes, token_expires_at,
  CASE WHEN access_token IS NOT NULL THEN 1 ELSE 0 END AS has_access_token,
  site_url,
  CASE WHEN consumer_key IS NOT NULL THEN 1 ELSE 0 END AS has_consumer_key,
  last_synced_at, last_sales_synced_at, live_sync_enabled, last_webhook_at, last_poll_at, last_poll_error, created_at, updated_at
`;
// Secrets (api_secret, access_token, consumer_key, consumer_secret) never leave the
// server once saved — the UI only ever needs to know "is something set", not what it is.

function list() {
  return db.prepare(`SELECT ${SAFE_FIELDS} FROM income_sources WHERE is_active = 1 ORDER BY platform, name`).all();
}

function getRaw(id) {
  const row = db.prepare('SELECT * FROM income_sources WHERE id = ?').get(id);
  if (!row) throw new ApiError(404, 'Income source not found.');
  for (const field of ENCRYPTED_FIELDS) row[field] = decrypt(row[field]);
  return row;
}

function getSafe(id) {
  const row = db.prepare(`SELECT ${SAFE_FIELDS} FROM income_sources WHERE id = ?`).get(id);
  if (!row) throw new ApiError(404, 'Income source not found.');
  return row;
}

// access_token is intentionally NOT user-settable — for Shopify it's obtained
// automatically via the client credentials grant (shopifyOAuth.service.js) from
// just shop_domain/api_key/api_secret, so the connection form only ever needs
// to ask for those three, never a token to paste in.
const SHOPIFY_FIELDS = ['shop_domain', 'api_key', 'api_secret', 'api_version'];
const WOO_FIELDS = ['site_url', 'consumer_key', 'consumer_secret'];

function create(data) {
  if (!data.name?.trim()) throw new ApiError(400, 'Name is required.');
  if (!['shopify', 'woocommerce'].includes(data.platform)) throw new ApiError(400, 'Platform must be "shopify" or "woocommerce".');

  const result = db.prepare(`
    INSERT INTO income_sources (name, platform, store_id, shop_domain, api_key, api_secret, api_version, site_url, consumer_key, consumer_secret)
    VALUES (@name, @platform, @store_id, @shop_domain, @api_key, @api_secret, @api_version, @site_url, @consumer_key, @consumer_secret)
  `).run({
    name: data.name.trim(),
    platform: data.platform,
    store_id: data.store_id || null,
    shop_domain: normalizeDomainOrUrl(data.shop_domain),
    api_key: data.api_key || null,
    api_secret: encrypt(data.api_secret || null),
    api_version: data.api_version || null,
    site_url: normalizeSiteUrl(data.site_url),
    consumer_key: encrypt(data.consumer_key || null),
    consumer_secret: encrypt(data.consumer_secret || null),
  });
  return getSafe(result.lastInsertRowid);
}

function update(id, data) {
  getRaw(id); // 404s if missing
  const fields = ['name', 'store_id', 'is_active', ...SHOPIFY_FIELDS, ...WOO_FIELDS];
  const sets = [];
  const params = { id };
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(data, f)) {
      // Blank string means "leave the stored secret alone" (the UI never re-sends a secret it can't see)
      if (['api_secret', 'consumer_key', 'consumer_secret'].includes(f) && data[f] === '') continue;
      sets.push(`${f} = @${f}`);
      if (f === 'shop_domain') params[f] = normalizeDomainOrUrl(data[f]);
      else if (f === 'site_url') params[f] = normalizeSiteUrl(data[f]);
      else if (ENCRYPTED_FIELDS.includes(f)) params[f] = encrypt(data[f]);
      else params[f] = data[f];
    }
  }
  if (sets.length === 0) return getSafe(id);
  // Changing shop_domain/api_key/api_secret invalidates any cached token — clear it
  // so the next sync/test is forced to fetch a fresh one against the new credentials.
  if (data.platform !== 'woocommerce' && (params.shop_domain !== undefined || params.api_key !== undefined || params.api_secret !== undefined)) {
    sets.push(`access_token = NULL`, `token_expires_at = NULL`, `oauth_scopes = NULL`);
  }
  db.prepare(`UPDATE income_sources SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = @id`).run(params);
  return getSafe(id);
}

function remove(id) {
  getRaw(id);
  db.prepare(`UPDATE income_sources SET is_active = 0, updated_at = datetime('now') WHERE id = ?`).run(id);
}

async function testConnection(id) {
  let source = getRaw(id);
  try {
    if (source.platform === 'shopify') {
      source = await shopifyOAuth.ensureFreshToken(source);
      const shop = await shopify.ping(source);
      const scopes = String(source.oauth_scopes || '');
      let message = `Connected to ${shop.name} (${shop.domain}). Granted scopes: ${scopes || '(none)'}.`;

      // /shop.json works with almost any token, so on its own "Connected" says nothing
      // about whether ORDERS can be read - which is what Sync sales needs. Check it.
      try {
        const count = await shopify.countOrders(source);
        message += ` Orders this app can see: ${count}.`;
        if (!scopes.includes('read_all_orders')) {
          message += ' (Shopify only shows an app the last 60 days of orders unless it has the read_all_orders scope - older history will not be imported.)';
        }
      } catch (err) {
        if (err.response && [401, 403].includes(err.response.status)) {
          message += ' WARNING: Shopify refused access to orders - add the read_orders access scope to your app (and read_all_orders for anything older than 60 days), then click Reconnect.';
        } else {
          message += ` Could not check order access: ${err.message}.`;
        }
      }
      return { ok: true, message };
    } else {
      const info = await woocommerce.ping(source);
      return { ok: true, message: `Connected to ${info.name}${info.version ? ` — WooCommerce ${info.version}` : ''}.` };
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.message?.includes('required') || err.message?.includes('must be set') || err.message?.includes("isn't connected")) throw new ApiError(400, err.message);
    throw fromUpstreamError(err, source.platform === 'shopify' ? 'Shopify' : 'WooCommerce');
  }
}

module.exports = { list, getRaw, getSafe, create, update, remove, testConnection };
