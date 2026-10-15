const logger = require('../utils/logger');

// These take the RAW body Safaricom/KCB actually POST — not the already-
// normalized shape paymentReconciliation.schema.js's webhookNotificationSchema
// expects (that schema is for the internal/manual-test webhook route; these
// adapters feed the same ingestNotification() function directly instead).

// Amounts arrive as decimal strings in shillings ("1500.00"). KCB's IPN in
// particular sends transactionAmt as a string, and a thousands separator
// ("1,500.00") would make a bare parseFloat silently read it as 1 — so strip
// separators first, and treat anything unparseable as 0 (ingestNotification
// then rejects it loudly rather than recording a nonsense amount).
function toCents(decimalAmount) {
  const cleaned = String(decimalAmount ?? '').replace(/[,\s]/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * Safaricom's C2B Validation request — sent BEFORE the transaction
 * completes, asking "should I let this go through". We always accept:
 * the app's philosophy everywhere else (WooCommerce sync, order import)
 * is "never silently drop money", and rejecting here would bounce a
 * customer's payment at the till, not just fail to record it. A rejected
 * BillRefNumber still gets recorded — matched or not — for the
 * reconciliation queue to sort out afterwards, same as any other
 * unmatched payment.
 */
function acceptValidation() {
  return { ResultCode: 0, ResultDesc: 'Accepted' };
}

/**
 * Safaricom's C2B Confirmation payload — the actual "money has moved"
 * notification. Real field names, per Daraja's docs:
 *   TransID, TransTime, TransAmount, BusinessShortCode, BillRefNumber,
 *   InvoiceNumber, OrgAccountBalance, ThirdPartyTransID, MSISDN,
 *   FirstName, MiddleName, LastName
 */
function adaptMpesaConfirmation(body) {
  const payerName = [body.FirstName, body.MiddleName, body.LastName].filter(Boolean).join(' ').trim() || body.MSISDN || null;
  return {
    method: 'mobile_money',
    amount: toCents(body.TransAmount),
    externalReference: body.TransID || null,
    narrative: body.BillRefNumber || null, // the product code lives here
    payerName,
    rawPayload: body,
  };
}

/**
 * Safaricom always expects the same ack back regardless of what we did
 * with the payment internally — ResultCode 0 just means "we received
 * this", not "we matched it to an order". Anything else makes Safaricom
 * treat the delivery as failed and retry it.
 */
function ackConfirmation() {
  return { ResultCode: 0, ResultDesc: 'Success' };
}

/**
 * KCB Buni IPN envelope — the shape the older (live) Urban Trends system
 * already receives and processes from KCB in production:
 *
 *   {
 *     header:         { messageID, originatorConversationID, channelCode, timeStamp },
 *     requestPayload: {
 *       primaryData:    { businessKey, businessKeyType },
 *       additionalData: { notificationData: {
 *         businessKey,        // "<prefix>#<code>", e.g. "8025631#A01" — the account the customer typed
 *         debitMSISDN,        // payer's phone
 *         transactionAmt,     // STRING, shillings, e.g. "1500.00"
 *         transactionDate, transactionID, firstName, middleName, lastName,
 *         currency, narration, transactionType, balance
 *       } }
 *     }
 *   }
 */
function kcbNotificationData(body) {
  return body?.requestPayload?.additionalData?.notificationData || null;
}

function isKcbIpnEnvelope(body) {
  return Boolean(kcbNotificationData(body));
}

function adaptKcbIpnEnvelope(body) {
  const n = kcbNotificationData(body);
  const header = body.header || {};

  const fullName = [n.firstName, n.middleName, n.lastName].filter(Boolean).join(' ').trim();
  const msisdn = n.debitMSISDN ? String(n.debitMSISDN) : null;
  const payerName = fullName ? (msisdn ? `${fullName} (${msisdn})` : fullName) : msisdn;

  // The account the customer typed ("8025631#UT000123") lands in
  // businessKey; extractProductCode() finds the UT###### anywhere inside,
  // so the shortcode/prefix is tolerated without having to strip it here.
  // The narration is appended as a second place the code might appear.
  const narrative = [n.businessKey || body?.requestPayload?.primaryData?.businessKey, n.narration]
    .filter(Boolean).join(' ') || null;

  // Idempotency key: transactionID is the money's own id. messageID is only a
  // fallback — it identifies the notification message, but a redelivery of
  // the same message carries the same one, so it still dedupes.
  const externalReference = n.transactionID || (header.messageID ? `kcb-msg:${header.messageID}` : null);

  const currency = n.currency ? String(n.currency).toUpperCase() : 'KES';
  let finalNarrative = narrative;
  if (currency !== 'KES') {
    // Amounts are stored as KES cents everywhere; applying a foreign-currency
    // number to an order as if it were shillings would corrupt balances. Record
    // it (never drop money) but force it into the manual-review queue.
    logger.warn(`KCB IPN ${externalReference} is in ${currency}, not KES — recorded as unmatched for manual review.`);
    finalNarrative = null;
  }

  return {
    method: 'mobile_money', // KCB paybill payments originate from M-Pesa phones (debitMSISDN); the old system booked these as 'BANK' — change here if you'd rather mirror that
    amount: toCents(n.transactionAmt),
    externalReference,
    narrative: finalNarrative,
    payerName,
    rawPayload: body,
  };
}

/**
 * What KCB expects back. Copied from the older system's working
 * KcbWebhookController: echo the message ids, statusCode "0", and the
 * transactionID. Always sent regardless of match outcome — "0" means
 * "received", not "matched" (same philosophy as the M-Pesa ack above).
 */
function ackKcbIpn(body) {
  const n = kcbNotificationData(body) || {};
  const header = body?.header || {};
  return {
    header: {
      messageID: header.messageID ?? null,
      originatorConversationID: header.originatorConversationID ?? null,
      statusCode: '0',
      statusMessage: 'Notification received successfully',
    },
    responsePayload: {
      transactionInfo: { transactionID: n.transactionID ?? null },
    },
  };
}

/**
 * Tolerant fallback for any NON-envelope KCB-style body (a different Buni
 * product, a flat test payload). Tries several plausible field names rather
 * than assuming one — rawPayload always keeps the complete original body, so
 * nothing is lost even if every guess is wrong.
 */
function adaptKcbFlatCallback(body) {
  const amountRaw = body.amount ?? body.TransAmount ?? body.transactionAmount ?? body.Amount;
  const reference = body.transactionId ?? body.TransID ?? body.reference ?? body.transactionReference ?? null;
  const narrative = body.accountNumber ?? body.BillRefNumber ?? body.narration ?? body.remarks ?? body.paymentReference ?? null;
  const payerName = body.customerName ?? body.payerName ?? body.senderName ?? body.MSISDN ?? null;

  return {
    method: 'mobile_money',
    amount: toCents(amountRaw),
    externalReference: reference,
    narrative,
    payerName,
    rawPayload: body,
  };
}

function adaptKcbCallback(body) {
  return isKcbIpnEnvelope(body) ? adaptKcbIpnEnvelope(body) : adaptKcbFlatCallback(body);
}

/**
 * Lipa Na M-Pesa Online (STK push) callback. Real envelope shape, per
 * Daraja's docs:
 *   { Body: { stkCallback: {
 *       MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc,
 *       CallbackMetadata: { Item: [ {Name, Value}, ... ] }  // only present when ResultCode === 0
 *   } } }
 * Deliberately NOT symmetrical with adaptMpesaConfirmation — this doesn't
 * produce ingestNotification() fields directly, because AccountReference
 * (the product code) isn't in this payload at all; the caller looks it up
 * from stk_push_requests by CheckoutRequestID instead. This just parses
 * the envelope into a flat, usable shape.
 */
function adaptMpesaStkCallback(body) {
  const cb = body?.Body?.stkCallback;
  if (!cb) return null;

  const items = cb.CallbackMetadata?.Item || [];
  const findItem = (name) => items.find((i) => i.Name === name)?.Value;

  return {
    checkoutRequestId: cb.CheckoutRequestID,
    merchantRequestId: cb.MerchantRequestID,
    resultCode: cb.ResultCode,
    resultDesc: cb.ResultDesc,
    succeeded: cb.ResultCode === 0,
    amount: findItem('Amount'), // shillings, decimal — only present on success
    mpesaReceiptNumber: findItem('MpesaReceiptNumber'),
    phoneNumber: findItem('PhoneNumber'),
  };
}

module.exports = {
  acceptValidation, adaptMpesaConfirmation, ackConfirmation,
  adaptKcbCallback, isKcbIpnEnvelope, ackKcbIpn,
  adaptMpesaStkCallback, toCents,
};
