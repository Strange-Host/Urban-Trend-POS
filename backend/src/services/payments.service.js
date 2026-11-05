const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const { logStaffAction } = require('../utils/auditLog');
const paymentRefunds = require('./paymentRefunds.service');
const approvalsService = require('./approvals.service');

// Payments here is interpretation B (decided): a distinct recording action —
// customer layaway/partial payments against a sale, or outgoing supplier
// payments — not an auto-populated view over Terminal's own charge flow.

// GET /api/payments?direction=&method=&status=&from=&to=&page=&limit=
function listPayments({ query, user }) {
  const { page, limit, offset } = parsePagination(query);
  const where = ['p.deleted_at IS NULL', 'p.store_id = ?'];
  const params = [user.storeId];
  if (query.direction) { where.push('p.direction = ?'); params.push(query.direction); }
  if (query.method) { where.push('p.method = ?'); params.push(query.method); }
  if (query.status) { where.push('p.status = ?'); params.push(query.status); }
  if (query.from) { where.push('p.created_at >= ?'); params.push(query.from); }
  if (query.to) { where.push('p.created_at <= ?'); params.push(query.to); }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT p.*, u.name AS recorded_by_name,
      (SELECT ar.id FROM approval_requests ar WHERE ar.payment_record_id = p.id AND ar.kind = 'refund_payment' AND ar.status = 'pending') AS pending_refund_request_id
    FROM payment_records p JOIN users u ON u.id = p.recorded_by_staff_id
    ${whereSql}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM payment_records p ${whereSql}`).get(...params).c;

  return paginatedResponse({ rows, total, page, limit });
}

// GET /api/payments/summary?from=&to= — totals by method
function paymentsSummary({ user, query }) {
  const where = ['deleted_at IS NULL', 'store_id = ?', "status = 'completed'"];
  const params = [user.storeId];
  if (query.from) { where.push('created_at >= ?'); params.push(query.from); }
  if (query.to) { where.push('created_at <= ?'); params.push(query.to); }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const byMethod = db.prepare(`
    SELECT method, direction, SUM(amount) AS total, COUNT(*) AS count
    FROM payment_records ${whereSql} GROUP BY method, direction
  `).all(...params);

  return { data: { by_method: byMethod } };
}

// POST /api/payments  { direction, sale_id?, supplier_name?, method, amount, reference?, notes? }
function createPayment({ body, user: reqUser }) {
  const { direction, sale_id, supplier_name, method, amount, reference, notes } = body;

  if (sale_id) {
    // 1.5 — scoped by store, same reasoning as everything above: without
    // this, a user could attach a payment record to a DIFFERENT store's
    // sale — the payment_records row would carry the current user's own
    // store_id while pointing at a sale that belongs to someone else's
    // store, a straight-up data integrity break as well as a boundary leak.
    const sale = db.prepare('SELECT id FROM sales WHERE id = ? AND store_id = ?').get(sale_id, reqUser.storeId);
    if (!sale) throw new ApiError(404, 'Referenced sale not found.');
  }

  const result = db.prepare(`
    INSERT INTO payment_records (store_id, direction, sale_id, supplier_name, method, amount, reference, notes, recorded_by_staff_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(reqUser.storeId, direction, sale_id || null, supplier_name || null, method, amount, reference || null, notes || null, reqUser.id);

  const payment = db.prepare('SELECT * FROM payment_records WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId: reqUser.id, action: 'create', entityType: 'payment', entityId: payment.id, after: payment });
  return { data: payment };
}

// POST /api/payments/:id/refund — for someone holding payments.refund. Anyone else files a request
// (POST /api/approvals) and a manager approves it; both end up in paymentRefunds.service.
function refundPayment({ params, user }) {
  const payment = paymentRefunds.refundPaymentRecord({
    paymentId: params.id, storeId: user.storeId, actor: { id: user.id, name: user.name },
  });
  // A request someone had open for this payment has just been answered.
  approvalsService.resolveDirect({ kind: 'refund_payment', entityId: payment.id, storeId: user.storeId, actor: { id: user.id, name: user.name } });
  return { data: payment };
}

module.exports = { listPayments, paymentsSummary, createPayment, refundPayment };
