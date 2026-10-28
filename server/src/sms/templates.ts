// The words of the two customer messages. Pure functions, so wording can be tested without a database. Ported from the legacy
// system's wording, with its hard-coded paybill, catalogue address and delivery promise turned into settings.

export type SmsSettings = Record<string, string>;

/** 150000 -> "1,500", 150050 -> "1,500.50". Cents in, text out; no floating point. */
export function formatKes(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = abs % 100;
  return frac === 0 ? `${sign}${whole}` : `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

export const firstName = (full: unknown): string => String(full ?? '').trim().split(/\s+/)[0] || 'there';

export function summarizeProducts(names: string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return 'your items';
  return clean.length === 1 ? clean[0]! : `${clean[0]} +${clean.length - 1} more`;
}

/** What the customer types at the paybill. An optional prefix ("8025631#") is what the bank hands back with the account, and is stripped on the way in. */
export const paymentAccount = (orderRef: string, s: SmsSettings): string => {
  const prefix = (s.kcb_account_prefix ?? '').trim().replace(/#+$/, '');
  return prefix ? `${prefix}#${orderRef}` : orderRef;
};

function payInstructions(s: SmsSettings, orderRef: string): string {
  const paybill = (s.paybill_number ?? '').trim();
  const account = paymentAccount(orderRef, s);
  // No paybill set: still give the customer their reference, rather than nothing.
  return paybill ? `Pay via Paybill ${paybill}, Account ${account}.` : `Your payment reference: ${account}.`;
}

export function orderReceived(i: { settings: SmsSettings; customerName: string; itemNames: string[]; orderRef: string }): string {
  const hello = `Hi ${firstName(i.customerName)}, we have received your order for ${summarizeProducts(i.itemNames)}.`;
  const promise = (i.settings.sms_delivery_promise ?? '').trim();
  return [i.settings.business_name || 'Urban Trends', promise ? `${hello} ${promise}` : hello, payInstructions(i.settings, i.orderRef), 'Thank you for choosing us.'].join('\n');
}

export function paymentReceived(i: { settings: SmsSettings; customerName: string; orderRef: string; amountCents: number; balanceCents: number }): string {
  const lines = [i.settings.business_name || 'Urban Trends'];
  const paid = `Hi ${firstName(i.customerName)}, we have received your payment of KES ${formatKes(i.amountCents)}.`;
  if (i.balanceCents > 0) lines.push(`${paid} Balance remaining: KES ${formatKes(i.balanceCents)}.`, payInstructions(i.settings, i.orderRef));
  else lines.push(`${paid} Your order is fully paid.`);
  lines.push('Thank you for shopping with us.');
  const catalog = (i.settings.sms_catalog_url ?? '').trim();
  if (catalog) lines.push(`Browse our catalog: ${catalog}`);
  return lines.join('\n');
}
