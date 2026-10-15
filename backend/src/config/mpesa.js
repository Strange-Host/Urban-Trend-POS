const axios = require('axios');
const ApiError = require('../utils/ApiError');
const { fromUpstreamError } = require('../utils/upstreamError');

// Same two base URLs for every Daraja product (OAuth, C2B, STK push) —
// which one to use is decided purely by the environment stored on the
// credentials row, same convention as income_sources' shopify/woocommerce env.
const BASE_URL = {
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
};

// Access tokens last ~1hr (Safaricom returns expires_in, usually "3599").
// Cached per consumer_key so a busy server doesn't re-authenticate on every
// single inbound/outbound call — same reasoning as shopifyOAuth's cached
// token, just kept in memory here instead of the DB since these tokens are
// short-lived enough that persisting them isn't worth the write traffic.
const tokenCache = new Map(); // consumer_key -> { token, expiresAt }
const REFRESH_SKEW_MS = 30_000;

function requireField(cred, field, label) {
  if (!cred[field]) throw new ApiError(400, `${label} is not set. Add it under Settings → Payment gateways → M-Pesa.`);
}

async function getAccessToken(cred) {
  requireField(cred, 'mpesa_consumer_key', 'M-Pesa consumer key');
  requireField(cred, 'mpesa_consumer_secret', 'M-Pesa consumer secret');

  const cached = tokenCache.get(cred.mpesa_consumer_key);
  if (cached && cached.expiresAt - Date.now() > REFRESH_SKEW_MS) return cached.token;

  const base = BASE_URL[cred.environment || 'sandbox'];
  const auth = Buffer.from(`${cred.mpesa_consumer_key}:${cred.mpesa_consumer_secret}`).toString('base64');

  let res;
  try {
    res = await axios.get(`${base}/oauth/v1/generate`, {
      params: { grant_type: 'client_credentials' },
      headers: { Authorization: `Basic ${auth}` },
      timeout: 15000,
    });
  } catch (err) {
    throw fromUpstreamError(err, 'M-Pesa');
  }

  if (!res.data.access_token) throw new ApiError(502, `Safaricom didn't return an access_token. Response: ${JSON.stringify(res.data)}`);

  const expiresAt = Date.now() + (parseInt(res.data.expires_in, 10) || 3599) * 1000;
  tokenCache.set(cred.mpesa_consumer_key, { token: res.data.access_token, expiresAt });
  return res.data.access_token;
}

/**
 * Tells Safaricom which URLs to call for C2B (paybill) payments against
 * this shortcode. ONE-TIME setup call per shortcode — re-registering just
 * overwrites the previous URLs, it's safe to call again if the app's
 * public URL changes. ValidationURL is optional on Safaricom's side
 * (controlled by ResponseType) but we always register both: Validation
 * lets us ACK/reject before the transaction completes, Confirmation is
 * the actual "money has moved" notification.
 */
async function registerC2BUrls(cred, { validationUrl, confirmationUrl }) {
  requireField(cred, 'mpesa_shortcode', 'Paybill / till number');
  const token = await getAccessToken(cred);
  const base = BASE_URL[cred.environment || 'sandbox'];

  try {
    const res = await axios.post(
      `${base}/mpesa/c2b/v2/registerurl`,
      {
        ShortCode: cred.mpesa_shortcode,
        ResponseType: 'Completed', // if Validation isn't reachable, Safaricom still forwards Confirmation
        ConfirmationURL: confirmationUrl,
        ValidationURL: validationUrl,
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    return res.data;
  } catch (err) {
    throw fromUpstreamError(err, 'M-Pesa');
  }
}

/**
 * Sandbox-only: fires a fake customer payment at your own registered
 * shortcode so you can watch it arrive at ConfirmationURL without a real
 * phone or real money. Safaricom rejects this call outright in production.
 */
async function simulateC2B(cred, { amount, msisdn, billRefNumber }) {
  if ((cred.environment || 'sandbox') !== 'sandbox') {
    throw new ApiError(400, 'Simulate is sandbox-only — switch Environment to Sandbox first, or use a real payment in production.');
  }
  requireField(cred, 'mpesa_shortcode', 'Paybill / till number');
  const token = await getAccessToken(cred);
  const base = BASE_URL.sandbox;

  try {
    const res = await axios.post(
      `${base}/mpesa/c2b/v2/simulate`,
      {
        ShortCode: cred.mpesa_shortcode,
        CommandID: 'CustomerPayBillOnline',
        Amount: amount,
        Msisdn: msisdn,
        BillRefNumber: billRefNumber,
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    return res.data;
  } catch (err) {
    throw fromUpstreamError(err, 'M-Pesa');
  }
}

/**
 * Lipa Na M-Pesa Online (STK push) — pushes a real PIN prompt to a phone.
 * Works in both sandbox and production and doesn't need C2B URLs
 * registered first, which makes it the easiest way to test end-to-end if
 * you'd rather not wait on registerC2BUrls/simulate. The result of the
 * push (success/cancel/timeout) arrives later at callbackUrl as its own
 * payload shape — different from C2B Confirmation — so a dedicated STK
 * callback route would be needed to actually ingest it; this function
 * just triggers the prompt for manual verification during setup.
 */
async function initiateStkPush(cred, { phone, amount, accountReference, description, callbackUrl }) {
  requireField(cred, 'mpesa_shortcode', 'Paybill / till number');
  requireField(cred, 'mpesa_passkey', 'Passkey');
  const token = await getAccessToken(cred);
  const base = BASE_URL[cred.environment || 'sandbox'];

  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14); // YYYYMMDDHHmmss
  const password = Buffer.from(`${cred.mpesa_shortcode}${cred.mpesa_passkey}${timestamp}`).toString('base64');

  try {
    const res = await axios.post(
      `${base}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: cred.mpesa_shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phone,
        PartyB: cred.mpesa_shortcode,
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: accountReference,
        TransactionDesc: description || 'Payment',
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    return res.data;
  } catch (err) {
    throw fromUpstreamError(err, 'M-Pesa');
  }
}

module.exports = { getAccessToken, registerC2BUrls, simulateC2B, initiateStkPush };
