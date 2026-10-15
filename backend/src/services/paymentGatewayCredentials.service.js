const crypto = require('crypto');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { encrypt, decrypt } = require('../utils/crypto');

const PROVIDERS = ['mpesa', 'kcb'];

// Same convention as incomeSources.service.js: fields that are genuinely
// secret get encrypted; identifying-but-not-secret fields (shortcode,
// account number, environment, initiator name) stay plaintext.
const ENCRYPTED_FIELDS = [
  'mpesa_consumer_key', 'mpesa_consumer_secret', 'mpesa_passkey', 'mpesa_initiator_password',
  'kcb_client_id', 'kcb_api_key', 'kcb_api_secret',
  'webhook_secret',
];

const PLAINTEXT_FIELDS = [
  'mpesa_shortcode', 'mpesa_initiator_name', 'kcb_account_number',
];

const ALL_FIELDS = [...ENCRYPTED_FIELDS, ...PLAINTEXT_FIELDS, 'environment'];

// Never returns raw secret values — only whether each is set. The UI only
// ever needs "is M-Pesa configured", not the actual consumer secret back.
function toSafeRow(row) {
  if (!row) return null;
  const safe = {
    id: row.id, store_id: row.store_id, provider: row.provider, is_active: row.is_active,
    environment: row.environment, last_synced_at: row.last_synced_at,
    created_at: row.created_at, updated_at: row.updated_at,
  };
  for (const field of PLAINTEXT_FIELDS) safe[field] = row[field];
  for (const field of ENCRYPTED_FIELDS) safe[`has_${field}`] = row[field] != null;
  return safe;
}

function assertValidProvider(provider) {
  if (!PROVIDERS.includes(provider)) throw new ApiError(400, `provider must be one of ${PROVIDERS.join(', ')}.`);
}

function list({ storeId }) {
  const rows = db.prepare('SELECT * FROM payment_gateway_credentials WHERE store_id = ?').all(storeId);
  return rows.map(toSafeRow);
}

function getSafe({ storeId, provider }) {
  assertValidProvider(provider);
  const row = db.prepare('SELECT * FROM payment_gateway_credentials WHERE store_id = ? AND provider = ?').get(storeId, provider);
  return toSafeRow(row); // null if never configured — that's a valid, meaningful answer, not a 404
}

// Internal use only (e.g. a future real API client actually calling out to
// KCB/M-Pesa) — decrypts every secret field. Never exposed directly over HTTP.
function getRaw({ storeId, provider }) {
  assertValidProvider(provider);
  const row = db.prepare('SELECT * FROM payment_gateway_credentials WHERE store_id = ? AND provider = ? AND is_active = 1').get(storeId, provider);
  if (!row) return null;
  for (const field of ENCRYPTED_FIELDS) row[field] = decrypt(row[field]);
  return row;
}

// Upsert — one row per (store, provider). A field the caller omits is left
// untouched on an update (so re-saving the shortcode doesn't wipe out an
// already-set consumer_secret you didn't resend).
function upsert({ storeId, provider, data }) {
  assertValidProvider(provider);
  if (data.environment && !['sandbox', 'production'].includes(data.environment)) {
    throw new ApiError(400, 'environment must be "sandbox" or "production".');
  }

  const existing = db.prepare('SELECT * FROM payment_gateway_credentials WHERE store_id = ? AND provider = ?').get(storeId, provider);

  const values = {};
  for (const field of ALL_FIELDS) {
    if (data[field] === undefined) {
      values[field] = existing ? existing[field] : null; // untouched fields keep whatever was already encrypted there
    } else if (ENCRYPTED_FIELDS.includes(field)) {
      values[field] = data[field] === null ? null : encrypt(data[field]);
    } else {
      values[field] = data[field];
    }
  }
  values.environment = values.environment || 'sandbox';

  if (existing) {
    db.prepare(`
      UPDATE payment_gateway_credentials SET
        environment = @environment,
        mpesa_shortcode = @mpesa_shortcode, mpesa_consumer_key = @mpesa_consumer_key, mpesa_consumer_secret = @mpesa_consumer_secret,
        mpesa_passkey = @mpesa_passkey, mpesa_initiator_name = @mpesa_initiator_name, mpesa_initiator_password = @mpesa_initiator_password,
        kcb_account_number = @kcb_account_number, kcb_client_id = @kcb_client_id, kcb_api_key = @kcb_api_key, kcb_api_secret = @kcb_api_secret,
        webhook_secret = @webhook_secret, updated_at = datetime('now')
      WHERE id = @id
    `).run({ ...values, id: existing.id });
    return getSafe({ storeId, provider });
  }

  db.prepare(`
    INSERT INTO payment_gateway_credentials (
      store_id, provider, environment, mpesa_shortcode, mpesa_consumer_key, mpesa_consumer_secret,
      mpesa_passkey, mpesa_initiator_name, mpesa_initiator_password, kcb_account_number, kcb_client_id,
      kcb_api_key, kcb_api_secret, webhook_secret
    ) VALUES (
      @store_id, @provider, @environment, @mpesa_shortcode, @mpesa_consumer_key, @mpesa_consumer_secret,
      @mpesa_passkey, @mpesa_initiator_name, @mpesa_initiator_password, @kcb_account_number, @kcb_client_id,
      @kcb_api_key, @kcb_api_secret, @webhook_secret
    )
  `).run({ ...values, store_id: storeId, provider });
  return getSafe({ storeId, provider });
}

// Used only by the raw M-Pesa/KCB callback routes (paymentCallbacks.*),
// which have no JWT session to scope a storeId from — Safaricom/KCB just
// hit a URL. The webhook_secret embedded in that URL path IS the auth
// (see paymentCallbacks.controller.js), so this scans every active row
// for the provider and returns whichever one's secret matches, the same
// "any active row for this provider" pragmatism webhookAuth.js already
// uses for the header-based normalized webhook. Returns the raw
// (decrypted) row — including store_id, so the caller knows which store
// this payment belongs to — or null if nothing matches.
function findByWebhookToken(provider, token) {
  assertValidProvider(provider);
  if (!token) return null;
  const rows = db.prepare('SELECT * FROM payment_gateway_credentials WHERE provider = ? AND is_active = 1').all(provider);
  const tokenBuf = Buffer.from(String(token));
  for (const row of rows) {
    const secret = decrypt(row.webhook_secret);
    if (!secret) continue;
    const secretBuf = Buffer.from(secret);
    if (tokenBuf.length === secretBuf.length && crypto.timingSafeEqual(tokenBuf, secretBuf)) {
      for (const field of ENCRYPTED_FIELDS) row[field] = decrypt(row[field]);
      return row;
    }
  }
  return null;
}

function deactivate({ storeId, provider }) {
  assertValidProvider(provider);
  const result = db.prepare(`
    UPDATE payment_gateway_credentials SET is_active = 0, updated_at = datetime('now') WHERE store_id = ? AND provider = ?
  `).run(storeId, provider);
  if (result.changes === 0) throw new ApiError(404, `${provider} credentials not found.`);
  return getSafe({ storeId, provider });
}

module.exports = { PROVIDERS, list, getSafe, getRaw, upsert, deactivate, findByWebhookToken };
