const asyncHandler = require('../utils/asyncHandler');
const logger = require('../utils/logger');
const reconciliationService = require('../services/paymentReconciliation.service');
const stkPushRequests = require('../services/stkPushRequests.service');
const adapters = require('../services/paymentCallbackAdapters');

// POST /api/integrations/payments/callbacks/mpesa/:token/validation
// Safaricom calls this BEFORE the transaction completes. Must respond
// fast with { ResultCode, ResultDesc } — this never touches the database.
const mpesaValidation = asyncHandler(async (req, res) => {
  res.json(adapters.acceptValidation());
});

// POST /api/integrations/payments/callbacks/mpesa/:token/confirmation
// The real "money has moved" notification.
const mpesaConfirmation = asyncHandler(async (req, res) => {
  const adapted = adapters.adaptMpesaConfirmation(req.body);
  reconciliationService.ingestNotification({
    storeId: req.gatewayCredentials.store_id,
    source: 'mpesa',
    ...adapted,
  });
  // Always ack 0 regardless of match/unmatched outcome — see ackConfirmation's comment.
  res.json(adapters.ackConfirmation());
});

// POST /api/integrations/payments/callbacks/kcb/:token/callback
// A real KCB Buni IPN gets the exact acknowledgement envelope KCB expects
// (HTTP 200, statusCode "0", ids echoed back). Any other body shape keeps the
// older flat { status, id } response so existing integrations don't break.
const kcbCallback = asyncHandler(async (req, res) => {
  const adapted = adapters.adaptKcbCallback(req.body);
  const notification = reconciliationService.ingestNotification({
    storeId: req.gatewayCredentials.store_id,
    source: 'kcb',
    ...adapted,
  });
  if (adapters.isKcbIpnEnvelope(req.body)) {
    return res.status(200).json(adapters.ackKcbIpn(req.body));
  }
  res.status(201).json({ status: 'received', id: notification.id });
});

// POST /api/integrations/payments/callbacks/mpesa/:token/stk
// STK push result. Unlike Confirmation, this arrives whether the push
// succeeded, was cancelled, or timed out — only a successful one produces
// money to reconcile. AccountReference isn't in this payload (see
// paymentCallbackAdapters' note), so it's recovered from the
// stk_push_requests row this CheckoutRequestID was recorded under.
const mpesaStkCallback = asyncHandler(async (req, res) => {
  const adapted = adapters.adaptMpesaStkCallback(req.body);
  if (!adapted) {
    logger.error('Received an M-Pesa STK callback with no recognizable stkCallback body.', { body: req.body });
    return res.json({ ResultCode: 0, ResultDesc: 'Success' });
  }

  const pending = stkPushRequests.findByCheckoutRequestId(adapted.checkoutRequestId);
  if (!pending) {
    logger.error(`Received an STK callback for an unknown CheckoutRequestID (${adapted.checkoutRequestId}) — was this push initiated from a different environment/database?`);
    return res.json({ ResultCode: 0, ResultDesc: 'Success' });
  }

  stkPushRequests.markResolved({
    checkoutRequestId: adapted.checkoutRequestId,
    status: adapted.succeeded ? 'completed' : 'failed',
    resultCode: adapted.resultCode,
    resultDesc: adapted.resultDesc,
  });

  if (adapted.succeeded) {
    reconciliationService.ingestNotification({
      storeId: pending.store_id,
      source: 'mpesa',
      method: 'mobile_money',
      amount: Math.round(parseFloat(adapted.amount || 0) * 100),
      externalReference: adapted.mpesaReceiptNumber,
      narrative: pending.account_reference, // the product code, recovered from what we stored at initiation
      payerName: adapted.phoneNumber ? String(adapted.phoneNumber) : null,
      rawPayload: req.body,
    });
  }
  // Cancelled/failed/timed-out pushes: no money moved, nothing to
  // reconcile — the resolved stk_push_requests row is the record of that.

  res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

module.exports = { mpesaValidation, mpesaConfirmation, kcbCallback, mpesaStkCallback };
