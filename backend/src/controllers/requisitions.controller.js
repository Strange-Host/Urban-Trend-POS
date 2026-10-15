const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const { logStaffAction } = require('../utils/auditLog');
const requisitionsService = require('../services/requisitions.service');

// GET /api/requisitions?status=&requested_by=&page=&limit=
const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const where = ['r.deleted_at IS NULL', 'r.store_id = ?'];
  const params = [req.user.storeId];
  if (req.query.status) { where.push('r.status = ?'); params.push(req.query.status); }
  if (req.query.requested_by) { where.push('r.requested_by_staff_id = ?'); params.push(req.query.requested_by); }
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
//   Shop operational (default): { notes, items: [{ product_id, quantity_requested }] }
//   Salary/personal advance:    { type: 'salary_advance', amount, notes }
const create = asyncHandler(async (req, res) => {
  const { notes, items, type, amount } = req.body;
  const requisitionType = type || 'shop_operational';
  if (requisitionType !== 'shop_operational' && requisitionType !== 'salary_advance') {
    throw new ApiError(400, `type must be one of shop_operational, salary_advance.`);
  }

  let requisitionId;
  if (requisitionType === 'salary_advance') {
    if (!amount || amount <= 0) throw new ApiError(400, 'amount (positive integer cents) is required for a salary_advance requisition.');
    const result = db.prepare(`
      INSERT INTO requisitions (store_id, requested_by_staff_id, type, amount, notes) VALUES (?, ?, 'salary_advance', ?, ?)
    `).run(req.user.storeId, req.user.id, amount, notes || null);
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
        INSERT INTO requisitions (store_id, requested_by_staff_id, notes) VALUES (?, ?, ?)
      `).run(req.user.storeId, req.user.id, notes || null);

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

module.exports = { list, getById, create, approve, reject };
