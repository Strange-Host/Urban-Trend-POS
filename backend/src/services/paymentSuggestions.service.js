const db = require('../config/db');

// Suggests which order an unmatched payment probably belongs to. Only orders that can still take a payment are offered
// (dispatched and not fully paid). The suggestion is a hint for a person to confirm, never an automatic match.
//   code   the payment's reference named this order's product code (strongest: the customer typed it)
//   amount the payment equals what is still owed on the order
//   phone  the customer's phone number appears in the payment details
//   name   the payer's name shares a word with the customer's name

const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

function suggest({ notification, q = '' }) {
  const text = `${notification.payer_name || ''} ${notification.external_reference || ''} ${notification.raw_payload || ''}`;
  const digits = text.replace(/[^0-9]/g, ' ').split(/\s+/);
  const payerWords = new Set(words(notification.payer_name));
  const needle = String(q || '').trim().toLowerCase();

  const orders = db.prepare(`
    SELECT o.id, o.product_code, o.status, o.total, o.amount_paid, c.name AS customer_name, c.phone AS customer_phone, c.phone_normalized
    FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE o.store_id = ? AND o.deleted_at IS NULL AND o.status IN ('dispatched_unpaid','dispatched_partial')
    ORDER BY o.id DESC LIMIT 1000
  `).all(notification.store_id);

  const out = [];
  for (const o of orders) {
    const balance = o.total - o.amount_paid;
    const reasons = []; let score = 0;
    if (notification.matched_code && o.product_code === notification.matched_code) { reasons.push('code'); score += 120; }
    if (balance === notification.amount) { reasons.push('amount'); score += 100; }
    if (o.phone_normalized && o.phone_normalized.length >= 9 && digits.some((d) => d.endsWith(o.phone_normalized))) { reasons.push('phone'); score += 60; }
    const shared = words(o.customer_name).filter((w) => payerWords.has(w));
    if (shared.length) { reasons.push('name'); score += 20 * shared.length; }
    const searched = needle && [o.customer_name, o.customer_phone, o.product_code].some((v) => String(v || '').toLowerCase().includes(needle));
    if (score === 0 && !searched) continue;
    out.push({
      orderId: o.id, number: o.product_code || `#${o.id}`, customerName: o.customer_name, customerPhone: o.customer_phone || null,
      totalCents: o.total, balanceCents: balance, status: o.status, score, reasons,
    });
  }
  return out.sort((a, b) => b.score - a.score || b.orderId - a.orderId).slice(0, 5);
}

module.exports = { suggest };
