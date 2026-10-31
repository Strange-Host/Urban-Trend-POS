const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const { logStaffAction } = require('../utils/auditLog');
const requisitionsService = require('../services/requisitions.service');
const { requireSignature } = require('../utils/signature');

// GET /api/requisitions?status=&requested_by=&page=&limit=
const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const where = ['r.deleted_at IS NULL', 'r.store_id = ?'];
  const params = [req.user.storeId];
  if (req.query.status) { where.push('r.status = ?'); params.push(req.query.status); }
  if (req.query.requested_by) { where.push('r.requested_by_staff_id = ?'); params.push(req.query.requested_by); }
  // ?awaiting_receipt=1: approved, but the person who asked has not yet signed for receiving it.
  if (req.query.awaiting_receipt === '1') where.push(`r.status = 'approved' AND r.receipt_signature_at IS NULL`);
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT r.*, u.name AS requested_by_name,
      (SELECT COUNT(*) FROM requisition_items WHERE requisition_id = r.id) AS item_count
    FROM requisitions r LEFT JOIN users u ON u.id = r.requested_by_staff_id
    ${whereSql}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM requisitions r ${whereSql}`).get(...params).c;

  res.json(paginatedResponse({ rows, total, page, limit }));
});

// GET /api/requisitions/:id
const getById = asyncHandler(async (req, res) => {
  const requisition = db.prepare('SELECT * FROM requisitions WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.user.storeId);
  if (!requisition) throw new ApiError(404, 'Requisition not found.');

  const items = db.prepare(`
    SELECT ri.*, p.name AS product_name, p.sku
    FROM requisition_items ri JOIN products p ON p.id = ri.product_id
    WHERE ri.requisition_id = ?
  `).all(requisition.id);

  res.json({ data: { ...requisition, items } });
});

// POST /api/requisitions
//   Shop operational (default): { notes, items: [{ product_id, quantity_requested }], signed_name }
//   Salary/personal advance:    { type: 'salary_advance', amount, notes, signed_name }
// signed_name is the requester's own full name, typed as their signature: for an advance it is their agreement that the
// amount comes off their pay; for goods, that they are asking for them. Checked against their account name.
const create = asyncHandler(async (req, res) => {
  const { notes, items, type, amount } = req.body;
  const requisitionType = type || 'shop_operational';
  if (requisitionType !== 'shop_operational' && requisitionType !== 'salary_advance') {
    throw new ApiError(400, `type must be one of shop_operational, salary_advance.`);
  }
  const signature = requireSignature(
    req.body.signed_name, req.user.name,
    requisitionType === 'salary_advance' ? 'this advance (you agree it is deducted from your pay)' : 'this requisition',
  );

  let requisitionId;
  if (requisitionType === 'salary_advance') {
    if (!amount || amount <= 0) throw new ApiError(400, 'amount (positive integer cents) is required for a salary_advance requisition.');
    const result = db.prepare(`
      INSERT INTO requisitions (store_id, requested_by_staff_id, type, amount, notes, request_signature_name, request_signature_at)
      VALUES (?, ?, 'salary_advance', ?, ?, ?, datetime('now'))
    `).run(req.user.storeId, req.user.id, amount, notes || null, signature);
    requisitionId = result.lastInsertRowid;
  } else {
    if (!Array.isArray(items) || items.length === 0) throw new ApiError(400, 'items must be a non-empty array.');
    for (const item of items) {
      if (!item.product_id || !item.quantity_requested || item.quantity_requested <= 0) {
        throw new ApiError(400, 'Each item requires product_id and a positive quantity_requested.');
      }
    }

    requisitionId = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO requisitions (store_id, requested_by_staff_id, notes, request_signature_name, request_signature_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(req.user.storeId, req.user.id, notes || null, signature);

      const insertItem = db.prepare(`
        INSERT INTO requisition_items (requisition_id, product_id, quantity_requested) VALUES (?, ?, ?)
      `);
      for (const item of items) insertItem.run(result.lastInsertRowid, item.product_id, item.quantity_requested);

      return result.lastInsertRowid;
    })();
  }

  const requisition = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(requisitionId);
  logStaffAction({ staffId: req.user.id, action: 'create', entityType: 'requisition', entityId: requisitionId, after: requisition });
  res.status(201).json({ data: requisition });
});

// PATCH /api/requisitions/:id/approve  { items: [{ product_id, quantity_approved }] }
const approve = asyncHandler(async (req, res) => {
  const requisition = requisitionsService.approve({
    requisitionId: req.params.id,
    items: req.body.items,
    staffId: req.user.id,
    storeId: req.user.storeId,
  });
  res.json({ data: requisition });
});

// PATCH /api/requisitions/:id/reject  { rejection_reason }
const reject = asyncHandler(async (req, res) => {
  const { rejection_reason } = req.body;
  if (!rejection_reason) throw new ApiError(400, 'rejection_reason is required.');

  const existing = db.prepare('SELECT * FROM requisitions WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.user.storeId);
  if (!existing) throw new ApiError(404, 'Requisition not found.');
  if (existing.status !== 'pending') throw new ApiError(409, 'Only pending requisitions can be rejected.');

  db.prepare(`
    UPDATE requisitions SET status = 'rejected', reviewed_by_staff_id = ?, reviewed_at = datetime('now'),
      rejection_reason = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(req.user.id, rejection_reason, req.params.id);

  const requisition = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(req.params.id);
  logStaffAction({
    staffId: req.user.id, action: 'update', entityType: 'requisition', entityId: requisition.id,
    before: { status: 'pending' }, after: { status: 'rejected', rejection_reason },
  });
  res.json({ data: requisition });
});

// PATCH /api/requisitions/:id/acknowledge  { signed_name }
// The requester's second signature: they confirm they actually received the money (advance) or the goods. Only the
// person who asked can sign it, only once the requisition is approved, and only once.
const acknowledgeReceipt = asyncHandler(async (req, res) => {
  const requisition = db.prepare('SELECT * FROM requisitions WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(req.params.id, req.user.storeId);
  if (!requisition) throw new ApiError(404, 'Requisition not found.');
  if (requisition.requested_by_staff_id !== req.user.id) {
    throw new ApiError(403, 'Only the person who made this request can acknowledge receiving it.', null, 'ACK_NOT_REQUESTER');
  }
  if (requisition.status !== 'approved') throw new ApiError(409, 'Only an approved requisition can be acknowledged as received.', null, 'ACK_NOT_APPROVED');
  if (requisition.receipt_signature_at) throw new ApiError(409, 'You have already acknowledged receiving this.', null, 'ACK_ALREADY_SIGNED');

  const signature = requireSignature(
    req.body.signed_name, req.user.name,
    requisition.type === 'salary_advance' ? 'that you received this advance' : 'that you received these goods',
  );
  db.prepare(`UPDATE requisitions SET receipt_signature_name = ?, receipt_signature_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(signature, requisition.id);
  const updated = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(requisition.id);
  logStaffAction({
    staffId: req.user.id, action: 'update', entityType: 'requisition', entityId: requisition.id,
    before: { receipt_signature_name: null }, after: { receipt_signature_name: signature },
  });
  res.json({ data: updated });
});

module.exports = { list, getById, create, approve, reject, acknowledgeReceipt };
