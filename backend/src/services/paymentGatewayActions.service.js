const systemConfig = require('./systemConfig.service');
const ApiError = require('../utils/ApiError');
const credentialsService = require('./paymentGatewayCredentials.service');
const stkPushRequests = require('./stkPushRequests.service');
const mpesaClient = require('../config/mpesa');
const kcbClient = require('../config/kcb');

function requireCredentials(storeId, provider) {
  const cred = credentialsService.getRaw({ storeId, provider });
  if (!cred) throw new ApiError(400, `${provider === 'mpesa' ? 'M-Pesa' : 'KCB'} isn't configured yet — save credentials in Settings first.`);
  return cred;
}

function requireAppBaseUrl() {
  const base = systemConfig.publicBaseUrl();
  if (!base) {
    throw new ApiError(
      400,
      'Your public web address is not set (APP_BASE_URL). Enter it under Settings > Server & public address. It must be a public HTTPS address ' +
      'Safaricom can reach - for example an ngrok tunnel while testing, or your real domain - then try again.'
    );
  }
  if (/mpesa|safaricom/i.test(base)) {
    throw new ApiError(400, 'The public web address (APP_BASE_URL) contains the word "mpesa" or "safaricom", which Safaricom rejects in callback URLs. Use a neutral domain or tunnel address.');
  }
  if (!/^https:\/\//i.test(base)) {
    throw new ApiError(400, 'The public web address (APP_BASE_URL) must start with https:// - Safaricom only calls secure addresses.');
  }
  return base.replace(/\/+$/, '');
}

async function testConnection(storeId, provider) {
  const cred = requireCredentials(storeId, provider);
  if (provider === 'mpesa') {
    await mpesaClient.getAccessToken(cred);
    return { ok: true, message: `Connected — Safaricom accepted the consumer key/secret and issued an access token (${cred.environment}).` };
  }
  const result = await kcbClient.testAuth(cred);
  return { ok: true, message: `Connected — KCB accepted the client credentials and issued an access token (${cred.environment}). ${result.tokenPreview}` };
}

/**
 * Registers this shortcode's Validation/Confirmation URLs with Safaricom.
 * One-time setup (or re-run whenever APP_BASE_URL changes) — after this,
 * Safaricom calls those URLs directly whenever a customer pays the
 * paybill, no polling needed.
 */
async function registerMpesaUrls(storeId) {
  const cred = requireCredentials(storeId, 'mpesa');
  if (!cred.webhook_secret) {
    throw new ApiError(400, 'Set a "Webhook shared secret" for M-Pesa first — it becomes part of the URL registered with Safaricom.');
  }
  const base = requireAppBaseUrl();
  const validationUrl = `${base}/api/integrations/payments/callbacks/c2b/${encodeURIComponent(cred.webhook_secret)}/validation`;
  const confirmationUrl = `${base}/api/integrations/payments/callbacks/c2b/${encodeURIComponent(cred.webhook_secret)}/confirmation`;

  const result = await mpesaClient.registerC2BUrls(cred, { validationUrl, confirmationUrl });
  return { ...result, validationUrl, confirmationUrl };
}

/** Sandbox-only — fires a fake payment at your own shortcode to test the whole pipeline end-to-end. */
async function simulateMpesaPayment(storeId, { amount, msisdn, billRefNumber }) {
  const cred = requireCredentials(storeId, 'mpesa');
  return mpesaClient.simulateC2B(cred, { amount, msisdn, billRefNumber });
}

/**
 * Pushes a real PIN prompt to a real phone — works in both sandbox and
 * production, doesn't need C2B URLs registered. Records the pending
 * request first so the callback (which arrives later, at a different URL
 * than C2B Confirmation) can look up which product code this was for.
 */
async function initiateMpesaStkPush(storeId, { phone, amount, accountReference, description }) {
  const cred = requireCredentials(storeId, 'mpesa');
  if (!cred.webhook_secret) {
    throw new ApiError(400, 'Set a "Webhook shared secret" for M-Pesa first — it becomes part of the callback URL.');
  }
  const base = requireAppBaseUrl();
  const callbackUrl = `${base}/api/integrations/payments/callbacks/c2b/${encodeURIComponent(cred.webhook_secret)}/stk`;
  const amountCents = Math.round(amount * 100);

  const result = await mpesaClient.initiateStkPush(cred, { phone, amount, accountReference, description, callbackUrl });

  if (result.ResponseCode !== '0' && result.ResponseCode !== 0) {
    // Safaricom accepted the HTTP call but rejected the push itself (bad
    // shortcode/passkey combo, etc.) — nothing to track, surface as-is.
    return result;
  }

  stkPushRequests.create({
    storeId,
    checkoutRequestId: result.CheckoutRequestID,
    merchantRequestId: result.MerchantRequestID,
    accountReference,
    phone,
    amount: amountCents,
  });

  return result;
}

module.exports = { testConnection, registerMpesaUrls, simulateMpesaPayment, initiateMpesaStkPush };
