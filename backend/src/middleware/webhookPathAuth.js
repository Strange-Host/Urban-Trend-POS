const crypto = require('crypto');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const db = require('../config/db');
const credentialsService = require('../services/paymentGatewayCredentials.service');

// Safaricom/KCB can't send a custom X-Webhook-Secret header the way our
// own internal/manual-test webhook route checks for (some payment
// platforms strip or don't support custom headers on their callback
// calls) — so for these raw provider callbacks, the shared secret is
// embedded directly in the registered URL's path instead:
//   /api/integrations/payments/callbacks/mpesa/<secret>/confirmation
// Anyone who doesn't know the secret gets a 404-shaped rejection (not a
// distinguishable 401) so a scan of this path space can't even tell a
// real endpoint apart from a wrong guess.
function firstActiveStoreId() {
  const row = db.prepare('SELECT id FROM stores WHERE is_active = 1 ORDER BY id LIMIT 1').get();
  return row ? row.id : null;
}

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function webhookPathAuth(provider) {
  return function (req, res, next) {
    const token = req.params.token;

    const matched = credentialsService.findByWebhookToken(provider, token);
    if (matched) {
      req.gatewayCredentials = matched;
      return next();
    }

    // Fall back to the server-wide secret (same one webhookAuth.js falls
    // back to for the normalized webhook) — with no per-store credentials
    // row to read a store_id from, this only works because Urban Trends
    // runs as a single store today (see urban-trends-pos notes).
    const globalSecret = process.env.PAYMENT_WEBHOOK_SECRET;
    if (globalSecret && timingSafeStringEqual(token, globalSecret)) {
      const storeId = firstActiveStoreId();
      if (!storeId) {
        logger.error(`${provider} callback authenticated via PAYMENT_WEBHOOK_SECRET but no active store exists to attribute the payment to.`);
        throw new ApiError(503, 'No active store configured.');
      }
      req.gatewayCredentials = { store_id: storeId, provider };
      return next();
    }

    logger.error(`Rejected ${provider} callback — token in URL didn't match any active ${provider} webhook secret.`);
    throw new ApiError(404, 'Not found.');
  };
}

module.exports = webhookPathAuth;
