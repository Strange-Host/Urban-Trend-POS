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

// Customer order history (§2): every order a customer has placed AT THIS SHOP, newest first, plus totals.
// Customers are shared across shops but orders are not, so everything is scoped by storeId and a customer
// with no order here is "not found" rather than leaking that they exist elsewhere.
// Identify the customer by id, or by phone (any common format - same last-9-digits rule as everywhere else).
function orderHistory({ storeId, customerId, phone, limit, offset }) {
  let customer;
  if (customerId !== undefined && customerId !== null) {
    const id = Number(customerId);
    customer = Number.isInteger(id) && id > 0 ? getById(id) : null;
  } else if (phone) {
    customer = findByPhone(phone);
  } else {
    throw new ApiError(400, 'Give a customer id or a phone number.');
  }
  const hasOrderHere = customer && db.prepare(
    'SELECT 1 FROM orders WHERE customer_id = ? AND store_id = ? AND deleted_at IS NULL LIMIT 1'
  ).get(customer.id, storeId);
  if (!hasOrderHere) throw new ApiError(404, 'No orders found for this customer.');

  const base = 'FROM orders o WHERE o.customer_id = ? AND o.store_id = ? AND o.deleted_at IS NULL';
  const rows = db.prepare(`
    SELECT o.id, o.product_code, o.status, o.channel, o.payment_type, o.total, o.amount_paid, o.delivery_zone,
           o.created_at, o.dispatched_at,
           (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
    ${base} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?
  `).all(customer.id, storeId, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(customer.id, storeId).n;

  // Over ALL their orders, not just the page on screen. Cancelled orders never count toward spend or what is owed.
  const s = db.prepare(`
    SELECT COUNT(*) AS orders,
      COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.total END), 0) AS total_ordered,
      COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.amount_paid END), 0) AS total_paid,
      COALESCE(SUM(CASE WHEN o.status != 'cancelled' THEN o.total - o.amount_paid END), 0) AS outstanding,
      COALESCE(SUM(CASE WHEN o.status = 'cancelled' THEN 1 END), 0) AS cancelled,
      COALESCE(SUM(CASE WHEN o.status LIKE 'returned%' THEN 1 END), 0) AS returned,
      MIN(o.created_at) AS first_order_at, MAX(o.created_at) AS last_order_at
    ${base}
  `).get(customer.id, storeId);

  return {
    customer: {
      id: customer.id, name: customer.name, phone: customer.phone, email: customer.email, city: customer.city,
      risk_flag: customer.risk_flag, prepay_required: customer.prepay_required,
    },
    rows, total, summary: s,
  };
}

module.exports = { RISK_FLAGS, findByPhone, getById, findOrCreate, evaluateRisk, orderHistory };
