const db = require('../config/db');

function create({ storeId, checkoutRequestId, merchantRequestId, accountReference, phone, amount }) {
  db.prepare(`
    INSERT INTO stk_push_requests (store_id, checkout_request_id, merchant_request_id, account_reference, phone, amount)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(storeId, checkoutRequestId, merchantRequestId || null, accountReference, phone, amount);
  return findByCheckoutRequestId(checkoutRequestId);
}

function findByCheckoutRequestId(checkoutRequestId) {
  return db.prepare('SELECT * FROM stk_push_requests WHERE checkout_request_id = ?').get(checkoutRequestId);
}

function markResolved({ checkoutRequestId, status, resultCode, resultDesc }) {
  db.prepare(`
    UPDATE stk_push_requests SET status = ?, result_code = ?, result_desc = ?, resolved_at = datetime('now')
    WHERE checkout_request_id = ?
  `).run(status, resultCode ?? null, resultDesc || null, checkoutRequestId);
}

module.exports = { create, findByCheckoutRequestId, markResolved };
