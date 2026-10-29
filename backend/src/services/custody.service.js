const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const ordersService = require('./orders.service');

// Shop cash custody. Ported from the update branch's server/src/orders/custody.ts.
//
// Cash taken at the shop is an exception, not a normal path: it needs a reason, it cannot exceed what
// the order still owes, and the staff member who took it HOLDS it, on a custody record, until it is
// deposited or handed to the till. Open custody ages on the money-at-risk page (cash_not_deposited).
// The update branch posts these moves to a double-entry ledger; there is no ledger here, so the
// custody record itself is the evidence: open = still in someone's hands, deposited = closed for good.
// All amounts are integer cents.

const custodyError = (status, code, message) => new ApiError(status, message, null, code);

/** Shop cash taken against an order: records the cash payment and opens a custody record for the taker. */
function recordShopCash({ orderId, storeId, staffId, amount, reason }) {
  if (!staffId) throw custodyError(422, 'PAYMENT_NO_ACTOR', 'The person taking the cash is required.');
  if (!String(reason || '').trim()) throw custodyError(422, 'CASH_REASON_REQUIRED', 'Cash at the shop is an exception: a reason is required.');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw custodyError(422, 'CASH_BAD_AMOUNT', 'amount must be a positive integer (cents).');

  return db.transaction(() => {
    const order = db.prepare('SELECT id, total, amount_paid FROM orders WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(orderId, storeId);
    if (!order) throw custodyError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    const balance = Math.max(order.total - order.amount_paid, 0);
    // Cash cannot be parked in suspense, so it can never be more than the order owes.
    if (amount > balance) throw custodyError(422, 'CASH_EXCEEDS_BALANCE', `That is more than the ${balance} cents this order still owes.`);

    const updated = ordersService.recordPayment({ orderId, storeId, staffId, method: 'cash', amount, reference: 'shop cash' });
    const payment = db.prepare(`SELECT id FROM payment_records WHERE order_id = ? AND direction = 'incoming' ORDER BY id DESC LIMIT 1`).get(orderId);
    const cleanReason = String(reason).trim();
    db.prepare('UPDATE payment_records SET notes = ? WHERE id = ?').run(`Shop cash: ${cleanReason}`, payment.id);
    const result = db.prepare(`
      INSERT INTO custody_records (store_id, holder_staff_id, order_id, payment_record_id, amount, reason) VALUES (?, ?, ?, ?, ?, ?)
    `).run(storeId, staffId, orderId, payment.id, amount, cleanReason);
    const record = db.prepare('SELECT * FROM custody_records WHERE id = ?').get(result.lastInsertRowid);
    logStaffAction({ staffId, action: 'create', entityType: 'custody_record', entityId: record.id, after: record });
    return { custody: record, order: updated, balance: balance - amount };
  })();
}

/** Open custody, oldest first: who holds how much, for which order. */
function listOpen({ storeId }) {
  return db.prepare(`
    SELECT c.id, c.holder_staff_id, u.name AS holder, c.order_id, o.product_code AS order_ref,
           c.amount, c.reason, c.opened_at
      FROM custody_records c
      JOIN users u ON u.id = c.holder_staff_id
      JOIN orders o ON o.id = c.order_id
     WHERE c.store_id = ? AND c.status = 'open'
     ORDER BY c.opened_at, c.id`).all(storeId);
}

/** The cash is deposited or handed to the till: the record closes and never changes again. */
function deposit({ custodyId, storeId, staffId }) {
  if (!staffId) throw custodyError(422, 'CUSTODY_NO_ACTOR', 'The person depositing the cash is required.');
  return db.transaction(() => {
    const rec = db.prepare('SELECT * FROM custody_records WHERE id = ? AND store_id = ?').get(custodyId, storeId);
    if (!rec) throw custodyError(404, 'CUSTODY_NOT_FOUND', 'Custody record not found.');
    // The status guard in the WHERE makes this safe even if two requests race: only one can change a row.
    const res = db.prepare(`
      UPDATE custody_records SET status = 'deposited', deposited_by = ?, deposited_at = datetime('now') WHERE id = ? AND status = 'open'
    `).run(staffId, rec.id);
    if (res.changes !== 1) throw custodyError(409, 'CUSTODY_ALREADY_DEPOSITED', 'This cash has already been deposited.');
    const after = db.prepare('SELECT * FROM custody_records WHERE id = ?').get(rec.id);
    logStaffAction({ staffId, action: 'update', entityType: 'custody_record', entityId: rec.id, before: rec, after });
    return { amount: rec.amount, custody: after };
  })();
}

module.exports = { recordShopCash, listOpen, deposit };
