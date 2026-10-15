// How a customer is told to pay. The older Urban Trends system had customers
// pay Paybill 522533 with account "<prefix>#<code>" (e.g. "8025631#A01XY");
// KCB hands that whole string back as businessKey in its IPN. The prefix is
// business-specific, so it lives in settings (kcb_account_prefix) rather than
// in code — leave it blank to tell customers just the bare product code.
//
// Matching does NOT need the prefix: extractProductCode() finds UT###### anywhere
// inside whatever string KCB/M-Pesa send, so both "UT000123" and
// "8025631#UT000123" reconcile to the same order.
function formatPaymentAccount(productCode, settings = {}) {
  if (!productCode) return '';
  const prefix = String(settings.kcb_account_prefix || '').trim().replace(/#+$/, '');
  return prefix ? `${prefix}#${productCode}` : productCode;
}

module.exports = { formatPaymentAccount };
