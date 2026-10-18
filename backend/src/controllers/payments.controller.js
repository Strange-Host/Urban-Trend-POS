const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const { logStaffAction } = require('../utils/auditLog');
const ordersService = require('../services/orders.service');

// Payments here is interpretation B (decided): a distinct recording action —
// customer layaway/partial payments against a sale, or outgoing supplier
// payments — not an auto-populated view over Terminal's own charge flow.

// GET /api/payments?direction=&method=&status=&from=&to=&page=&limit=
const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const where = ['p.deleted_at IS NULL', 'p.store_id = ?'];
  const params = [req.user.storeId];
  if (req.query.direction) { where.push('p.direction = ?'); params.push(req.query.direction); }
  if (req.query.method) { where.push('p.method = ?'); params.push(req.query.method); }
  if (req.query.status) { where.push('p.status = ?'); params.push(req.query.status); }
  if (req.query.from) { where.push('p.created_at >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('p.created_at <= ?'); params.push(req.query.to); }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT p.*, u.name AS recorded_by_name
    FROM payment_records p JOIN users u ON u.id = p.recorded_by_staff_id
    ${whereSql}
    ORDER BY p.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM payment_records p ${whereSql}`).get(...params).c;

  res.json(paginatedResponse({ rows, total, page, limit }));
});

// GET /api/payments/summary?from=&to= — totals by method
const summary = asyncHandler(async (req, res) => {
  const where = ['deleted_at IS NULL', 'store_id = ?', "status = 'completed'"];
  const params = [req.user.storeId];
  if (req.query.from) { where.push('created_at >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('created_at <= ?'); params.push(req.query.to); }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const byMethod = db.prepare(`
    SELECT method, direction, SUM(amount) AS total, COUNT(*) AS count
    FROM payment_records ${whereSql} GROUP BY method, direction
  `).all(...params);

  res.json({ data: { by_method: byMethod } });
});

// POST /api/payments  { direction, sale_id?, supplier_name?, method, amount, reference?, notes? }
const create = asyncHandler(async (req, res) => {
  const { direction, sale_id, supplier_name, method, amount, reference, notes } = req.body;

  if (sale_id) {
    // 1.5 — scoped by store, same reasoning as everything above: without
    // this, a user could attach a payment record to a DIFFERENT store's
    // sale — the payment_records row would carry the current user's own
    // store_id while pointing at a sale that belongs to someone else's
    // store, a straight-up data integrity break as well as a boundary leak.
    const sale = db.prepare('SELECT id FROM sales WHERE id = ? AND store_id = ?').get(sale_id, req.user.storeId);
    if (!sale) throw new ApiError(404, 'Referenced sale not found.');
  }

  const result = db.prepare(`
    INSERT INTO payment_records (store_id, direction, sale_id, supplier_name, method, amount, reference, notes, recorded_by_staff_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.storeId, direction, sale_id || null, supplier_name || null, method, amount, reference || null, notes || null, req.user.id);

  const payment = db.prepare('SELECT * FROM payment_records WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId: req.user.id, action: 'create', entityType: 'payment', entityId: payment.id, after: payment });
  res.status(201).json({ data: payment });
});

// POST /api/payments/:id/refund
const refund = asyncHandler(async (req, res) => {
  const existing = db.prepare('SELECT * FROM payment_records WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.user.storeId);
  if (!existing) throw new ApiError(404, 'Payment not found.');
  if (existing.status !== 'completed') throw new ApiError(409, `Payment is already ${existing.status}.`);

  // Refunds reference the original record rather than deleting it — both rows
  // are needed for audit purposes even though net revenue nets to zero (§4.3).
  // If the payment was against an online order, the order's amount_paid and status must follow it
  // (same transaction), or the order would keep showing money the shop has handed back.
  db.transaction(() => {
    db.prepare(`UPDATE payment_records SET status = 'refunded', updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
    if (existing.order_id && existing.direction === 'incoming') {
      ordersService.refundPayment({
        orderId: existing.order_id, storeId: req.user.storeId, amount: existing.amount,
        staffId: req.user.id, method: existing.method,
      });
    }
  })();
  const payment = db.prepare('SELECT * FROM payment_records WHERE id = ?').get(req.params.id);
  logStaffAction({
    staffId: req.user.id, action: 'update', entityType: 'payment', entityId: payment.id,
    before: { status: 'completed' }, after: { status: 'refunded' },
  });
  require('../services/securityAlerts.service').largeMoney({
    storeId: req.user.storeId, actor: { id: req.user.id, name: req.user.name }, kind: 'refund', amountCents: existing.amount, reference: `#${payment.id}`,
  });
  res.json({ data: payment });
});

module.exports = { list, summary, create, refund };
