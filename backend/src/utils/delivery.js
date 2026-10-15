// Nairobi vs. outside-Nairobi drives both the delivery-timeline messaging
// (§1: 2hrs vs 24-48hrs) and which courier gets auto-suggested. This is a
// simple substring match on the customer's city/town — good enough for the
// common case (city is literally "Nairobi" or a Nairobi estate name isn't
// distinguished from the county here); a proper ward/estate lookup can
// replace this later without touching any caller.
function determineDeliveryZone(city) {
  if (!city) return 'outside'; // no city on file — treat as outside-Nairobi (longer timeline, safer default)
  return /nairobi/i.test(city) ? 'nairobi' : 'outside';
}

// Auto-suggested (§1 Pickup options: "Auto-suggested based on location &
// phone number") — location is what's actually available at order time;
// phone-based courier history can refine this later. Always overridable by
// whoever's placing the order.
function suggestCourier(deliveryZone) {
  return deliveryZone === 'nairobi' ? 'boda' : 'g4s';
}

// Tiered delivery fee (§7 pricing described in the WhatsApp log): flat fee
// under the threshold, percentage above it. Both the threshold and the
// rates are read from Settings rather than hardcoded, so a fee change
// doesn't need a code deploy — see settings.service.js DEFAULTS for the
// out-of-the-box values (KSh 300 flat under KSh 5,000, 5% above).
function computeDeliveryFee(orderTotalCents, settings) {
  const thresholdCents = parseInt(settings.delivery_fee_threshold_kes, 10) * 100;
  const flatFeeCents = parseInt(settings.delivery_fee_flat_kes, 10) * 100;
  const percent = parseFloat(settings.delivery_fee_percent);

  if (orderTotalCents < thresholdCents) return flatFeeCents;
  return Math.round(orderTotalCents * (percent / 100));
}

module.exports = { determineDeliveryZone, suggestCourier, computeDeliveryFee };
