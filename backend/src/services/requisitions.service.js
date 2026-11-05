const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const { todaySql } = require('../utils/storeTime');
const stock = require('./stock.service');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const { requireSignature } = require('../utils/signature');

const REQUISITION_CATEGORY = 'Shop Requisitions';

function requisitionCategoryId() {
  const existing = db.prepare('SELECT id FROM expense_categories WHERE name = ?').get(REQUISITION_CATEGORY);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO expense_categories (name) VALUES (?)').run(REQUISITION_CATEGORY).lastInsertRowid;
}

// Forwards an approved shop requisition to the Expenditure module: one expense, linked by requisition_id, worth
// the approved quantities at each product's current cost price. The approver is the authority for the spend, so
// the expense lands already approved; it still shows in Expenditure (and its totals) like any other, and the
// UNIQUE index on expenses.requisition_id means a requisition can never be forwarded twice.
// Runs inside approve()'s transaction, so the requisition, stock and expense commit together or not at all.
function forwardToExpenditure({ requisition, lineItems, approvedQty, staffId, storeId }) {
  let amount = 0;
  const parts = [];
  const unpriced = [];
  for (const line of lineItems) {
    const qty = approvedQty.get(line.id);
    if (!qty) continue;
    const product = db.prepare('SELECT name, cost_price FROM products WHERE id = ?').get(line.product_id);
    const unitCost = product?.cost_price || 0;
    amount += qty * unitCost;
    parts.push(`${qty} × ${product?.name || `product ${line.product_id}`}`);
    if (!unitCost) unpriced.push(product?.name || `product ${line.product_id}`);
  }
  if (parts.length === 0) return null; // everything was approved at zero: nothing was spent

  const requester = db.prepare('SELECT name FROM users WHERE id = ?').get(requisition.requested_by_staff_id);
  let description = `Shop requisition #${requisition.id} for ${requester?.name || 'staff'}: ${parts.join(', ')}`;
  if (requisition.notes) description += ` — ${requisition.notes}`;
  if (unpriced.length) description += ` (no cost price on file for ${unpriced.join(', ')}; edit the amount)`;

  const today = db.prepare(`SELECT ${todaySql()} AS d`).get().d;
  const result = db.prepare(`
    INSERT INTO expenses (store_id, category_id, amount, description, expense_date, recorded_by_staff_id,
                          status, reviewed_by_staff_id, reviewed_at, requisition_id)
    VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, datetime('now'), ?)
  `).run(storeId, requisitionCategoryId(), amount, description, today, staffId, staffId, requisition.id);

  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId, action: 'create', entityType: 'expense', entityId: expense.id, after: expense });
  return expense;
}

// Approving a requisition auto-increments inventory.on_hand (decided: yes).
// This runs as a single better-sqlite3 transaction — requisition status,
// each requisition_item's quantity_approved, the inventory row, and the
// inventory_movements ledger entry all commit together or not at all, so a
// partial failure never leaves stock and paperwork out of sync (§2.2).
function approve({ requisitionId, items, staffId, storeId }) {
  const txn = db.transaction(() => {
    const requisition = db.prepare('SELECT * FROM requisitions WHERE id = ? AND deleted_at IS NULL').get(requisitionId);
    if (!requisition) throw new ApiError(404, 'Requisition not found.');
    if (requisition.status !== 'pending') throw new ApiError(409, 'Only pending requisitions can be approved.');

    // §10 Salary/Personal Advances: no product line items to approve —
    // just posts straight to payroll_adjustments so it's "automatically
    // deducted from salary" the next time a payroll summary is pulled.
    if (requisition.type === 'salary_advance') {
      db.prepare(`
        INSERT INTO payroll_adjustments (staff_id, store_id, type, amount, requisition_id, notes, created_by)
        VALUES (?, ?, 'salary_advance', ?, ?, ?, ?)
      `).run(requisition.requested_by_staff_id, requisition.store_id || storeId, requisition.amount, requisitionId, requisition.notes, staffId);

      db.prepare(`
        UPDATE requisitions SET status = 'approved', reviewed_by_staff_id = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(staffId, requisitionId);

      logStaffAction({
        staffId, action: 'update', entityType: 'requisition', entityId: requisitionId,
        before: { status: 'pending' }, after: { status: 'approved', type: 'salary_advance' },
      });

      return db.prepare('SELECT * FROM requisitions WHERE id = ?').get(requisitionId);
    }

    const lineItems = db.prepare('SELECT * FROM requisition_items WHERE requisition_id = ?').all(requisitionId);
    const approvedByLine = new Map((items || []).map((i) => [i.product_id, i.quantity_approved]));
    const approvedQty = new Map(); // requisition_items.id -> quantity actually approved

    for (const line of lineItems) {
      const qtyApproved = approvedByLine.has(line.product_id)
        ? approvedByLine.get(line.product_id)
        : line.quantity_requested;
      if (qtyApproved < 0) throw new ApiError(400, `quantity_approved for product ${line.product_id} cannot be negative.`);

      db.prepare('UPDATE requisition_items SET quantity_approved = ? WHERE id = ?').run(qtyApproved, line.id);
      approvedQty.set(line.id, qtyApproved);

      if (qtyApproved > 0) {
        // Multi-store aware: adds to the requesting staff member's store.
        stock.applyMovement({ productId: line.product_id, storeId, change: qtyApproved, reason: 'requisition', referenceType: null, referenceId: requisitionId, userId: staffId });
      }
    }

    db.prepare(`
      UPDATE requisitions SET status = 'approved', reviewed_by_staff_id = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(staffId, requisitionId);

    forwardToExpenditure({ requisition, lineItems, approvedQty, staffId, storeId });

    logStaffAction({
      staffId,
      action: 'update',
      entityType: 'requisition',
      entityId: requisitionId,
      before: { status: 'pending' },
      after: { status: 'approved' },
    });

    return db.prepare('SELECT * FROM requisitions WHERE id = ?').get(requisitionId);
  });

  return txn();
}

// GET /api/requisitions?status=&requested_by=&page=&limit=
function listRequisitions({ query, user }) {
  const { page, limit, offset } = parsePagination(query);
  const where = ['r.deleted_at IS NULL', 'r.store_id = ?'];
  const params = [user.storeId];
  if (query.status) { where.push('r.status = ?'); params.push(query.status); }
  if (query.requested_by) { where.push('r.requested_by_staff_id = ?'); params.push(query.requested_by); }
  // ?awaiting_receipt=1: approved, but the person who asked has not yet signed for receiving it.
  if (query.awaiting_receipt === '1') where.push(`r.status = 'approved' AND r.receipt_signature_at IS NULL`);
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

  return paginatedResponse({ rows, total, page, limit });
}

// GET /api/requisitions/:id
function getRequisition({ params, user }) {
  const requisition = db.prepare('SELECT * FROM requisitions WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(params.id, user.storeId);
  if (!requisition) throw new ApiError(404, 'Requisition not found.');

  const items = db.prepare(`
    SELECT ri.*, p.name AS product_name, p.sku
    FROM requisition_items ri JOIN products p ON p.id = ri.product_id
    WHERE ri.requisition_id = ?
  `).all(requisition.id);

  return { data: { ...requisition, items } };
}

// POST /api/requisitions
//   Shop operational (default): { notes, items: [{ product_id, quantity_requested }], signed_name }
//   Salary/personal advance:    { type: 'salary_advance', amount, notes, signed_name }
// signed_name is the requester's own full name, typed as their signature: for an advance it is their agreement that the
// amount comes off their pay; for goods, that they are asking for them. Checked against their account name.
function createRequisition({ body, user }) {
  const { notes, items, type, amount } = body;
  const requisitionType = type || 'shop_operational';
  if (requisitionType !== 'shop_operational' && requisitionType !== 'salary_advance') {
    throw new ApiError(400, `type must be one of shop_operational, salary_advance.`);
  }
  const signature = requireSignature(
    body.signed_name, user.name,
    requisitionType === 'salary_advance' ? 'this advance (you agree it is deducted from your pay)' : 'this requisition',
  );

  let requisitionId;
  if (requisitionType === 'salary_advance') {
    if (!amount || amount <= 0) throw new ApiError(400, 'amount (positive integer cents) is required for a salary_advance requisition.');
    const result = db.prepare(`
      INSERT INTO requisitions (store_id, requested_by_staff_id, type, amount, notes, request_signature_name, request_signature_at)
      VALUES (?, ?, 'salary_advance', ?, ?, ?, datetime('now'))
    `).run(user.storeId, user.id, amount, notes || null, signature);
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
      `).run(user.storeId, user.id, notes || null, signature);

      const insertItem = db.prepare(`
        INSERT INTO requisition_items (requisition_id, product_id, quantity_requested) VALUES (?, ?, ?)
      `);
      for (const item of items) insertItem.run(result.lastInsertRowid, item.product_id, item.quantity_requested);

      return result.lastInsertRowid;
    })();
  }

  const requisition = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(requisitionId);
  logStaffAction({ staffId: user.id, action: 'create', entityType: 'requisition', entityId: requisitionId, after: requisition });
  return { data: requisition };
}

// PATCH /api/requisitions/:id/approve  { items: [{ product_id, quantity_approved }] }
function approveRequisition({ params, body, user }) {
  const requisition = approve({
    requisitionId: params.id,
    items: body.items,
    staffId: user.id,
    storeId: user.storeId,
  });
  return { data: requisition };
}

// PATCH /api/requisitions/:id/reject  { rejection_reason }
function rejectRequisition({ body, params, user }) {
  const { rejection_reason } = body;
  if (!rejection_reason) throw new ApiError(400, 'rejection_reason is required.');

  const existing = db.prepare('SELECT * FROM requisitions WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(params.id, user.storeId);
  if (!existing) throw new ApiError(404, 'Requisition not found.');
  if (existing.status !== 'pending') throw new ApiError(409, 'Only pending requisitions can be rejected.');

  db.prepare(`
    UPDATE requisitions SET status = 'rejected', reviewed_by_staff_id = ?, reviewed_at = datetime('now'),
      rejection_reason = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(user.id, rejection_reason, params.id);

  const requisition = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(params.id);
  logStaffAction({
    staffId: user.id, action: 'update', entityType: 'requisition', entityId: requisition.id,
    before: { status: 'pending' }, after: { status: 'rejected', rejection_reason },
  });
  return { data: requisition };
}

// PATCH /api/requisitions/:id/acknowledge  { signed_name }
// The requester's second signature: they confirm they actually received the money (advance) or the goods. Only the
// person who asked can sign it, only once the requisition is approved, and only once.
function acknowledgeReceipt({ params, user, body }) {
  const requisition = db.prepare('SELECT * FROM requisitions WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(params.id, user.storeId);
  if (!requisition) throw new ApiError(404, 'Requisition not found.');
  if (requisition.requested_by_staff_id !== user.id) {
    throw new ApiError(403, 'Only the person who made this request can acknowledge receiving it.', null, 'ACK_NOT_REQUESTER');
  }
  if (requisition.status !== 'approved') throw new ApiError(409, 'Only an approved requisition can be acknowledged as received.', null, 'ACK_NOT_APPROVED');
  if (requisition.receipt_signature_at) throw new ApiError(409, 'You have already acknowledged receiving this.', null, 'ACK_ALREADY_SIGNED');

  const signature = requireSignature(
    body.signed_name, user.name,
    requisition.type === 'salary_advance' ? 'that you received this advance' : 'that you received these goods',
  );
  db.prepare(`UPDATE requisitions SET receipt_signature_name = ?, receipt_signature_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(signature, requisition.id);
  const updated = db.prepare('SELECT * FROM requisitions WHERE id = ?').get(requisition.id);
  logStaffAction({
    staffId: user.id, action: 'update', entityType: 'requisition', entityId: requisition.id,
    before: { receipt_signature_name: null }, after: { receipt_signature_name: signature },
  });
  return { data: updated };
}

module.exports = { approve, listRequisitions, getRequisition, createRequisition, approveRequisition, rejectRequisition, acknowledgeReceipt };
