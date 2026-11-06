// Sale discounts at the till. The server is the control (sales.service rejects a discount above the cashier's limit);
// this only mirrors its arithmetic so the till can say so before the sale is charged or queued offline. Integer cents
// throughout; the limit is a percent of the goods' list value, 0 meaning no limit.

/** True when `discount` is more than `maxPercent` of `subtotal`. Same comparison as the backend's assertDiscountPercent. */
export function discountExceedsLimit({ discount, subtotal, maxPercent }) {
  const pct = Number(maxPercent);
  if (!pct || pct <= 0 || subtotal <= 0) return false;
  const basisPoints = Math.round(pct * 100);
  return discount * 10000 > subtotal * basisPoints;
}

/** "12.5%" for a discount against a subtotal; "0%" when there is none. One decimal at most, never a trailing ".0". */
export function discountPercentLabel(discount, subtotal) {
  if (!discount || subtotal <= 0) return '0%';
  const pct = Math.round((discount / subtotal) * 1000) / 10;
  return `${pct}%`;
}
