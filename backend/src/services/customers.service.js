const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { normalizePhone } = require('../utils/phone');

const RISK_FLAGS = ['none', 'watch', 'high'];

// Online orders (§2) key customers by phone, same convention as leads:
// re-using an existing customer row when the phone matches, rather than
// creating a new one every time someone orders again.
function findByPhone(phone) {
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return null;
  return db.prepare('SELECT * FROM customers WHERE phone_normalized = ?').get(phoneNormalized);
}

function getById(id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

function findOrCreate({ name, phone, email, city }) {
  if (!phone) throw new ApiError(400, 'phone is required.');
  const existing = findByPhone(phone);
  if (existing) {
    // Fill in anything new the order supplied that the stored profile is
    // missing (e.g. first order had no email, this one does) — never
    // overwrites a value that's already set, so one order can't silently
    // clobber another's detail for the same customer.
    const finalName = existing.name || name;
    const finalEmail = existing.email || email || null;
    const finalCity = existing.city || city || null;
    if (finalName !== existing.name || finalEmail !== existing.email || finalCity !== existing.city) {
      db.prepare(`
        UPDATE customers SET name = ?, email = ?, city = ?, updated_at = datetime('now') WHERE id = ?
      `).run(finalName, finalEmail, finalCity, existing.id);
      return getById(existing.id);
    }
    return existing;
  }

  if (!name) throw new ApiError(400, 'name is required for a new customer.');
  const result = db.prepare(`
    INSERT INTO customers (name, phone, phone_normalized, email, city)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, phone, normalizePhone(phone), email || null, city || null);
  return getById(result.lastInsertRowid);
}

// Repeat COD-rejecters/no-pickups get flagged and, past a threshold,
// required to prepay (§3 Customer Risk Management). Called from
// orders.service whenever an order lands on returned_in_transit — never
// set directly from request input.
function evaluateRisk(customerId) {
  const row = db.prepare(`
    SELECT COUNT(*) c FROM orders
    WHERE customer_id = ? AND status IN ('returned_in_transit','returned_awaiting_inspection','returned_resellable','returned_damaged')
  `).get(customerId);

  const rejections = row.c;
  let riskFlag = 'none';
  let prepayRequired = 0;
  if (rejections >= 3) {
    riskFlag = 'high';
    prepayRequired = 1;
  } else if (rejections >= 1) {
    riskFlag = 'watch';
  }

  db.prepare(`
    UPDATE customers SET risk_flag = ?, prepay_required = ?, updated_at = datetime('now') WHERE id = ?
  `).run(riskFlag, prepayRequired, customerId);

  return getById(customerId);
}

module.exports = { RISK_FLAGS, findByPhone, getById, findOrCreate, evaluateRisk };
