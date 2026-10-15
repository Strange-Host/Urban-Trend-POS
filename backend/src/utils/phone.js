// Normalizes a phone number for duplicate-lead detection: strips everything
// but digits, then compares the last 9 (handles country-code variance, e.g.
// +254712345678 vs 0712345678 vs 712345678 all normalize the same way).
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.slice(-9);
}

// Turns a Kenyan number in any common format (0712 345 678, +254712345678,
// 254712345678, 712345678) into the 2547XXXXXXXX / 2541XXXXXXXX form SMS
// gateways expect. Returns null — never a guess — when it doesn't look like a
// Kenyan mobile number, so callers can skip the send instead of paying for a
// message that can't be delivered.
function toMsisdn(phone) {
  const last9 = normalizePhone(phone);
  return /^[17]\d{8}$/.test(last9) ? `254${last9}` : null;
}

module.exports = { normalizePhone, toMsisdn };
