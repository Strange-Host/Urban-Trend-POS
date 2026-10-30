const ApiError = require('./ApiError');

// Server-side discount caps (Phase 0). The browser already stops an obviously
// silly discount, but the browser is not a control: anyone calling the API
// directly could post a discount larger than the item, or larger than the whole
// sale, and drive the total negative or to nothing. These checks sit in the
// services so every way of creating a sale or an order passes through them.
//
// All amounts are integer cents, the same unit the rest of the money code uses.

function money(cents) {
  return (cents / 100).toFixed(2);
}

// A line's discount must be a whole, non-negative amount and may not exceed what
// that line is worth before the discount (unit price x quantity).
function assertLineDiscount({ discount, unitPrice, quantity, productName }) {
  if (!Number.isInteger(discount) || discount < 0) {
    throw new ApiError(400, `Invalid discount for "${productName}".`);
  }
  const lineGross = unitPrice * quantity;
  if (discount > lineGross) {
    throw new ApiError(
      400,
      `Discount (${money(discount)}) on "${productName}" cannot be more than the line value (${money(lineGross)}).`
    );
  }
}

// The sale-wide discount comes off the subtotal (the sum of the lines AFTER their
// own discounts), so it may not exceed that subtotal or the total would go negative.
function assertSaleDiscount({ discountTotal, subtotal }) {
  if (!Number.isInteger(discountTotal) || discountTotal < 0) {
    throw new ApiError(400, 'Invalid discount total.');
  }
  if (discountTotal > subtotal) {
    throw new ApiError(
      400,
      `Discount (${money(discountTotal)}) cannot be more than the sale value (${money(subtotal)}).`
    );
  }
}

// Percentage ceiling (Priority 5). `max_discount_percent` in Settings caps the TOTAL discount
// (line discounts plus the sale-wide one) as a share of the goods' list value. 0 means no
// limit, and managers/admins are not held to it, so a cashier who needs to go further asks
// one of them to ring the sale. Integer cents throughout, so the comparison is exact.
function maxPercentFor(role, settings) {
  if (role === 'admin' || role === 'manager') return 0;
  const pct = parseFloat(settings.max_discount_percent);
  return Number.isFinite(pct) && pct > 0 ? pct : 0;
}

function assertDiscountPercent({ lineDiscountTotal, saleDiscount, grossTotal, maxPercent }) {
  if (!maxPercent) return;
  const discount = lineDiscountTotal + saleDiscount;
  if (grossTotal > 0 && discount * 100 > grossTotal * maxPercent) {
    const given = ((discount / grossTotal) * 100).toFixed(1);
    throw new ApiError(400, `Discount of ${given}% is above the ${maxPercent}% limit. Ask a manager to approve it.`);
  }
}

module.exports = { assertLineDiscount, assertSaleDiscount, maxPercentFor, assertDiscountPercent };
