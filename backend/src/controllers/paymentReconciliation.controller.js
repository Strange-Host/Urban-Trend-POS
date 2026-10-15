const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const reconciliationService = require('../services/paymentReconciliation.service');

// POST /api/integrations/kcb/webhook — auth: webhookAuth middleware, not JWT
const kcbWebhook = asyncHandler(async (req, res) => {
  const { store_id, method, amount, external_reference, narrative, payer_name, raw_payload, direction } = req.body;
  const notification = reconciliationService.ingestNotification({
    storeId: store_id, source: 'kcb', method, amount, direction,
    externalReference: external_reference, narrative, payerName: payer_name, rawPayload: raw_payload ?? req.body,
  });
  res.status(201).json({ data: notification });
});

// POST /api/integrations/mpesa/webhook — auth: webhookAuth middleware, not JWT
const mpesaWebhook = asyncHandler(async (req, res) => {
  const { store_id, method, amount, external_reference, narrative, payer_name, raw_payload, direction } = req.body;
  const notification = reconciliationService.ingestNotification({
    storeId: store_id, source: 'mpesa', method, amount, direction,
    externalReference: external_reference, narrative, payerName: payer_name, rawPayload: raw_payload ?? req.body,
  });
  res.status(201).json({ data: notification });
});

// GET /api/payment-reconciliation/unmatched?page=&limit=
const listUnmatched = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { rows, total, summary } = reconciliationService.listUnmatched({ storeId: req.user.storeId, limit, offset });
  res.json({ ...paginatedResponse({ rows, total, page, limit }), summary });
});

// POST /api/payment-reconciliation/:id/match
const manualMatch = asyncHandler(async (req, res) => {
  const { order_id, method, reference } = req.body;
  const notification = reconciliationService.manualMatch({
    notificationId: req.params.id, storeId: req.user.storeId, orderId: order_id, staffId: req.user.id, method, reference,
  });
  res.json({ data: notification });
});

// POST /api/payment-reconciliation/:id/ignore
const ignore = asyncHandler(async (req, res) => {
  const notification = reconciliationService.ignore({
    notificationId: req.params.id, storeId: req.user.storeId, staffId: req.user.id,
  });
  res.json({ data: notification });
});

module.exports = { kcbWebhook, mpesaWebhook, listUnmatched, manualMatch, ignore };
