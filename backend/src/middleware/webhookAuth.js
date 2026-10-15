const crypto = require('crypto');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const db = require('../config/db');
const { decrypt } = require('../utils/crypto');

// A DB-stored per-provider secret (Settings → Payment Gateways) takes
// precedence once someone sets one; the global env var is the fallback
// for anyone who configured this before per-provider credentials existed.
// Deliberately not store-scoped here — webhook auth just needs *a* valid
// shared secret to check against, and almost every deployment of this app
// runs a single store, so "any active row for this provider" is the
// pragmatic choice over parsing req.body.store_id before validation has
// even run.
function getConfiguredSecret(provider) {
  if (provider) {
    const row = db.prepare(`
      SELECT webhook_secret FROM payment_gateway_credentials WHERE provider = ? AND is_active = 1 AND webhook_secret IS NOT NULL LIMIT 1
    `).get(provider);
    if (row) {
      const decrypted = decrypt(row.webhook_secret);
      if (decrypted) return decrypted;
    }
  }
  return process.env.PAYMENT_WEBHOOK_SECRET || null;
}

// KCB/M-Pesa call this endpoint directly — there's no user session to
// check a JWT against, so a shared secret (set on both ends when the
// webhook is registered) is what stands in for auth here. Same idea as
// JWT_SECRET/ENCRYPTION_KEY in validateEnv.js: a real deployment needs
// this actually set, but nothing else here should hard-crash the process
// over an integration that might not be configured yet.
function webhookAuth(provider) {
  return function (req, res, next) {
    const configuredSecret = getConfiguredSecret(provider);
    if (!configuredSecret) {
      logger.error(`No webhook secret configured for ${provider || 'this provider'} — rejecting inbound payment webhook. Set it via PUT /api/settings/payment-gateways/${provider} or the PAYMENT_WEBHOOK_SECRET env var.`);
      throw new ApiError(503, 'Payment webhook is not configured on this server yet.');
    }

    const provided = req.headers['x-webhook-secret'];
    const providedBuf = Buffer.from(String(provided || ''));
    const configuredBuf = Buffer.from(configuredSecret);
    // timingSafeEqual requires equal-length buffers and throws otherwise —
    // check length first so a short guess can't even reach the timing-safe
    // comparison (and can't throw past this middleware either).
    const isValid = providedBuf.length === configuredBuf.length && crypto.timingSafeEqual(providedBuf, configuredBuf);

    if (!isValid) throw new ApiError(401, 'Invalid webhook secret.');
    next();
  };
}

module.exports = webhookAuth;
