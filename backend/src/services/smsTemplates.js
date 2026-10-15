// Pure message builders — no DB access, so they're trivially unit-testable.
// Wording is ported from the older system's MessagingService ("we have
// received your order for X … paybill / account number …", "we have received
// your payment of KES …"), with its hardcoded paybill, catalog URL and 24-hour
// delivery promise turned into settings, and its two fixed templates made
// partial-payment aware.
const { formatPaymentAccount } = require('../utils/paymentReference');

// 150000 -> "1,500", 150050 -> "1,500.50"
function formatKes(cents) {
  const whole = Math.trunc(cents / 100);
  const frac = Math.abs(cents % 100);
  const intPart = String(Math.abs(whole)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = cents < 0 ? '-' : '';
  return frac === 0 ? `${sign}${intPart}` : `${sign}${intPart}.${String(frac).padStart(2, '0')}`;
}

function firstName(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0];
  return first || 'there';
}

function summarizeProducts(names) {
  const clean = (names || []).filter(Boolean);
  if (clean.length === 0) return 'your items';
  if (clean.length === 1) return clean[0];
  return `${clean[0]} +${clean.length - 1} more`;
}

function payInstructions(settings, productCode) {
  const account = formatPaymentAccount(productCode, settings);
  const paybill = String(settings.paybill_number || '').trim();
  if (paybill) return `Pay via Paybill ${paybill}, Account ${account}.`;
  // No paybill configured — still give the customer their reference rather than nothing.
  return `Your payment reference: ${account}.`;
}

function orderReceived({ settings, customerName, productNames, productCode }) {
  const lines = [
    settings.business_name || 'Urban Trends',
    `Hi ${firstName(customerName)}, we have received your order for ${summarizeProducts(productNames)}.`,
  ];
  const promise = String(settings.sms_delivery_promise || '').trim();
  if (promise) lines[1] += ` ${promise}`;
  lines.push(payInstructions(settings, productCode));
  lines.push('Thank you for choosing us.');
  return lines.join('\n');
}

function paymentReceived({ settings, customerName, productCode, amountCents, balanceCents }) {
  const lines = [
    settings.business_name || 'Urban Trends',
  ];
  let line = `Hi ${firstName(customerName)}, we have received your payment of KES ${formatKes(amountCents)}.`;
  if (balanceCents > 0) {
    line += ` Balance remaining: KES ${formatKes(balanceCents)}.`;
    lines.push(line);
    lines.push(payInstructions(settings, productCode));
  } else {
    line += ' Your order is fully paid.';
    lines.push(line);
  }
  lines.push('Thank you for shopping with us.');
  const catalog = String(settings.sms_catalog_url || '').trim();
  if (catalog) lines.push(`Browse our catalog: ${catalog}`);
  return lines.join('\n');
}

module.exports = { formatKes, firstName, summarizeProducts, orderReceived, paymentReceived };
