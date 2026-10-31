const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const { todaySql } = require('../utils/storeTime');

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
        // Multi-store aware: adjust the requesting staff member's store inventory row.
        const existingInv = db.prepare('SELECT * FROM inventory WHERE product_id = ? AND store_id = ?').get(line.product_id, storeId);
        if (existingInv) {
          db.prepare(`UPDATE inventory SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?`)
            .run(qtyApproved, existingInv.id);
        } else {
          db.prepare(`INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, ?, ?)`)
            .run(line.product_id, storeId, qtyApproved);
        }
        db.prepare(`
          INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, reference_id, created_by)
          VALUES (?, ?, ?, 'requisition', ?, ?)
        `).run(line.product_id, storeId, qtyApproved, requisitionId, staffId);
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

module.exports = { approve };
