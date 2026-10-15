const asyncHandler = require('../utils/asyncHandler');
const credentialsService = require('../services/paymentGatewayCredentials.service');
const actionsService = require('../services/paymentGatewayActions.service');

// GET /api/settings/payment-gateways
const list = asyncHandler(async (req, res) => {
  res.json({ data: credentialsService.list({ storeId: req.user.storeId }) });
});

// GET /api/settings/payment-gateways/:provider
const getByProvider = asyncHandler(async (req, res) => {
  res.json({ data: credentialsService.getSafe({ storeId: req.user.storeId, provider: req.params.provider }) });
});

// PUT /api/settings/payment-gateways/:provider
const upsert = asyncHandler(async (req, res) => {
  const data = credentialsService.upsert({ storeId: req.user.storeId, provider: req.params.provider, data: req.body });
  res.json({ data });
});

// DELETE /api/settings/payment-gateways/:provider — deactivates, doesn't drop the row (keeps history/audit)
const deactivate = asyncHandler(async (req, res) => {
  const data = credentialsService.deactivate({ storeId: req.user.storeId, provider: req.params.provider });
  res.json({ data });
});

// POST /api/settings/payment-gateways/:provider/test — round-trips an
// actual OAuth token request against Safaricom/KCB, so "Configured" in
// the UI can mean "these credentials really authenticate", not just
// "something was typed into the fields".
const testConnection = asyncHandler(async (req, res) => {
  const result = await actionsService.testConnection(req.user.storeId, req.params.provider);
  res.json({ data: result });
});

// POST /api/settings/payment-gateways/mpesa/register-urls — one-time
// (or re-run-after-APP_BASE_URL-changes) call that tells Safaricom where
// to send C2B Validation/Confirmation for this shortcode.
const registerMpesaUrls = asyncHandler(async (req, res) => {
  const result = await actionsService.registerMpesaUrls(req.user.storeId);
  res.json({ data: result });
});

// POST /api/settings/payment-gateways/mpesa/simulate — sandbox-only test
// payment, so the whole webhook → match → order pipeline can be verified
// without a real phone or real money.
const simulateMpesaPayment = asyncHandler(async (req, res) => {
  const result = await actionsService.simulateMpesaPayment(req.user.storeId, req.body);
  res.json({ data: result });
});

// POST /api/settings/payment-gateways/mpesa/stk-push — pushes a real PIN
// prompt, works in sandbox and production alike.
const initiateMpesaStkPush = asyncHandler(async (req, res) => {
  const result = await actionsService.initiateMpesaStkPush(req.user.storeId, req.body);
  res.json({ data: result });
});

module.exports = { list, getByProvider, upsert, deactivate, testConnection, registerMpesaUrls, simulateMpesaPayment, initiateMpesaStkPush };
