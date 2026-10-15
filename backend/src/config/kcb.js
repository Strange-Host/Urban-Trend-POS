const axios = require('axios');
const ApiError = require('../utils/ApiError');
const { fromUpstreamError } = require('../utils/upstreamError');

// ---------------------------------------------------------------------
// HONESTY NOTE — read before wiring this up to a real KCB account.
//
// Unlike Safaricom Daraja (public docs, self-serve sandbox, stable URLs),
// KCB's developer platform (Buni) gates its real API catalogue behind an
// approved developer/business account, and the exact base URL, token
// path, and callback-registration endpoint depend on WHICH product you're
// subscribed to (their API catalogue includes several different payment
// products, not one single "C2B" like Safaricom). The values below are
// the best-effort, commonly-cited defaults for Buni's OAuth2
// client-credentials flow — they are NOT verified against a live
// account. Treat this file as a scaffold with the right shape, not a
// finished, tested integration.
//
// Once you have real Buni sandbox access:
//   1. Confirm the actual base URL and token path from your product's
//      docs page in the Buni portal and set the KCB addresses (Settings > Payment gateways > KCB > Advanced) /
//      the token path there if they differ.
//   2. Confirm the actual callback-registration call (or whether KCB
//      instead wants you to paste the callback URL into a portal form
//      by hand, with no API call at all — some of their products work
//      that way).
//   3. Confirm the real inbound callback payload shape by triggering one
//      test transaction and reading raw_payload on the resulting
//      payment_notifications row — then tighten
//      paymentCallbackAdapters.adaptKcbCallback to match it exactly
//      instead of the tolerant best-guess parsing it does today.
// ---------------------------------------------------------------------

// Base addresses and the token path come from Settings > Payment gateways > KCB > Advanced
// (or backend/.env), read each time so a change needs no restart. See systemConfig.service.js.
const systemConfig = require('../services/systemConfig.service');

const tokenCache = new Map(); // client_id -> { token, expiresAt }
const REFRESH_SKEW_MS = 30_000;

function requireField(cred, field, label) {
  if (!cred[field]) throw new ApiError(400, `${label} is not set. Add it under Settings → Payment gateways → KCB.`);
}

async function getAccessToken(cred) {
  requireField(cred, 'kcb_client_id', 'KCB client ID');
  requireField(cred, 'kcb_api_key', 'KCB API key');
  requireField(cred, 'kcb_api_secret', 'KCB API secret');

  const cached = tokenCache.get(cred.kcb_client_id);
  if (cached && cached.expiresAt - Date.now() > REFRESH_SKEW_MS) return cached.token;

  const cfg = systemConfig.kcb();
  const base = cfg[cred.environment === 'production' ? 'production' : 'sandbox'];

  let res;
  try {
    // Standard OAuth2 client_credentials grant, client id/secret sent as
    // HTTP Basic auth — the most common shape for Buni's products. Swap
    // to a client_id/client_secret-in-body POST here if your product's
    // docs say otherwise.
    const auth = Buffer.from(`${cred.kcb_client_id}:${cred.kcb_api_secret}`).toString('base64');
    res = await axios.post(
      `${base}${cfg.tokenPath}`,
      new URLSearchParams({ grant_type: 'client_credentials' }),
      {
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          apikey: cred.kcb_api_key, // several Buni products additionally require this header
        },
        timeout: 15000,
      }
    );
  } catch (err) {
    throw fromUpstreamError(err, 'KCB');
  }

  const accessToken = res.data.access_token || res.data.accessToken;
  if (!accessToken) throw new ApiError(502, `KCB didn't return an access token. Response: ${JSON.stringify(res.data)}`);

  const expiresIn = parseInt(res.data.expires_in || res.data.expiresIn, 10) || 3599;
  const expiresAt = Date.now() + expiresIn * 1000;
  tokenCache.set(cred.kcb_client_id, { token: accessToken, expiresAt });
  return accessToken;
}

/**
 * Verifies the credentials actually authenticate — the one thing that IS
 * portable across KCB products, since every OAuth2 client-credentials
 * grant either succeeds or fails regardless of which specific payment
 * product sits behind it. This is what the Settings "Test connection"
 * button calls; it deliberately does NOT attempt callback registration,
 * since that endpoint's real shape is unconfirmed (see note above).
 */
async function testAuth(cred) {
  const token = await getAccessToken(cred);
  return { ok: true, tokenPreview: `${token.slice(0, 8)}…` };
}

module.exports = { getAccessToken, testAuth };
