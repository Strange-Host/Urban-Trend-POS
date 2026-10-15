const axios = require('axios');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { fromUpstreamError } = require('../utils/upstreamError');
const { encrypt } = require('../utils/crypto');

// Client Credentials Grant (RFC 6749 §4.4): the app exchanges its own
// Client ID + Secret directly with the shop, server-to-server, no browser
// redirect and no callback URL. Shopify's docs specifically call this out
// as the right flow for "apps developed by your own organization and
// installed in stores that you own" — which is exactly this setup (an
// internal POS talking to its own store's Shopify), as opposed to a public
// app installed by many different unrelated merchants (which needs the
// authorization-code flow with user consent). Trade-off: these tokens only
// last 24h and must be refreshed — ensureFreshToken() below does that
// automatically before every sync so it's invisible day to day.
const REFRESH_SKEW_MS = 60_000; // refresh a little early rather than racing an exact expiry

/** Does the actual token exchange and persists the result. */
async function fetchClientCredentialsToken(source) {
  if (!source.shop_domain || !source.api_key || !source.api_secret) {
    throw new ApiError(400, 'Set the shop domain, API key, and API secret (from the Shopify Dev Dashboard) before connecting.');
  }

  const body = new URLSearchParams({
    client_id: source.api_key,
    client_secret: source.api_secret,
    grant_type: 'client_credentials',
  });

  let res;
  try {
    res = await axios.post(`https://${source.shop_domain}/admin/oauth/access_token`, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    });
  } catch (err) {
    throw fromUpstreamError(err, 'Shopify');
  }

  if (!res.data.access_token) {
    throw new ApiError(502, `Shopify didn't return an access_token. Response: ${JSON.stringify(res.data)}`);
  }

  // `scope` here is what the app is actually configured for in the Dev
  // Dashboard — client credentials tokens don't negotiate scope by request,
  // unlike the old flow, so whatever comes back is exactly what you get.
  const expiresAt = new Date(Date.now() + (res.data.expires_in || 86399) * 1000).toISOString();

  db.prepare(`
    UPDATE income_sources SET access_token = ?, oauth_scopes = ?, token_expires_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(encrypt(res.data.access_token), res.data.scope || '', expiresAt, source.id);

  return { ...source, access_token: res.data.access_token, oauth_scopes: res.data.scope || '', token_expires_at: expiresAt };
}

/**
 * Returns a source guaranteed to have a currently-valid access token,
 * fetching or refreshing one first if it's missing or about to expire.
 * Call this before any Shopify API call — it's a cheap no-op most of the
 * time (24h tokens don't need refreshing on every sync).
 */
async function ensureFreshToken(source) {
  const expiresAt = source.token_expires_at ? new Date(source.token_expires_at).getTime() : 0;
  if (source.access_token && expiresAt - Date.now() > REFRESH_SKEW_MS) {
    return source; // still good
  }
  return fetchClientCredentialsToken(source);
}

module.exports = { fetchClientCredentialsToken, ensureFreshToken };
