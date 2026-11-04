const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const settingsService = require('./settings.service');
const permissionsService = require('./permissions.service');
const notifications = require('./notifications.service');
const securityAlerts = require('./securityAlerts.service');

// One place that changes a product's stock by hand. The website's POST /api/inventory/adjust and the mobile app's
// POST /api/v1/stock/adjustments both end here, so the rules (never below zero, every change in the movements ledger, the
// large-adjustment alert) cannot drift apart.
//
// On top of that the app has an approval rule: an adjustment of `stock_adjust_approval_units` or more asked for by anyone
// who does not hold inventory.approve_adjust (the owner by default) is not applied. It is saved as a request, the people who
// can decide are told, and approving it applies it through apply() below.

// The app's fixed list of reasons -> the movement reason the ledger stores (its CHECK list is fixed too).
const REASONS = {
  damaged: 'adjustment', lost: 'adjustment', found: 'adjustment', count_correction: 'adjustment', return_to_stock: 'return', other: 'adjustment',
};

/** Applies a change to inventory + the ledger in one transaction. Throws 400 if it would go below zero. Returns the inventory row. */
function apply({ storeId, productId, changeQty, movementReason, userId }) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, storeId);
    if (existing) {
      const newQty = existing.quantity + changeQty;
      if (newQty < 0) throw new ApiError(400, 'Adjustment would result in negative stock.');
      db.prepare(`UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE id = ?`).run(newQty, existing.id);
    } else {
      if (changeQty < 0) throw new ApiError(400, 'Cannot reduce stock that does not exist yet.');
      db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, ?, ?)').run(productId, storeId, changeQty);
    }
    db.prepare(`INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, created_by) VALUES (?, ?, ?, ?, ?)`)
      .run(productId, storeId, changeQty, movementReason, userId);
    return db.prepare('SELECT * FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, storeId);
  })();
}

const approvalUnits = () => {
  const n = Number(settingsService.getAll().stock_adjust_approval_units);
  return Number.isFinite(n) && n > 0 ? n : Infinity;     // 0 / blank switches the rule off
};

function loadProduct(productId, storeId) {
  const p = db.prepare(`SELECT id, name FROM products WHERE id = ? AND is_active = 1 AND approval_status = 'approved'`).get(productId);
  if (!p) throw new ApiError(404, 'Product not found.');
  return p;
}

/**
 * The mobile entry point. Returns { applied: true, newAvailable } or { applied: false, approvalId, approvalRef }.
 * user = req.user ({ id, role, storeId, name }).
 */
function adjustFromApp({ user, productId, delta, reason, note, device = null }) {
  if (!Number.isInteger(productId) || !Number.isInteger(delta) || delta === 0) throw new ApiError(400, 'productId and a non-zero whole-number delta are required.');
  if (!REASONS[reason]) throw new ApiError(400, `reason must be one of ${Object.keys(REASONS).join(', ')}.`);
  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 200) : '';
  if (reason === 'other' && cleanNote.length < 3) throw new ApiError(400, 'Say what happened in the note when the reason is "other".');
  const product = loadProduct(productId, user.storeId);

  // Refuse an impossible change up front, so nobody waits on an approval that could never be applied.
  const current = db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, user.storeId);
  if ((current?.quantity ?? 0) + delta < 0) throw new ApiError(400, 'Adjustment would result in negative stock.');

  const needsApproval = Math.abs(delta) >= approvalUnits() && !permissionsService.can(user, 'inventory.approve_adjust');
  if (needsApproval) {
    const id = db.prepare(`INSERT INTO stock_adjustment_requests (store_id, product_id, change_qty, reason, note, requested_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(user.storeId, productId, delta, reason, cleanNote || null, user.id).lastInsertRowid;
    logStaffAction({ staffId: user.id, action: 'create', entityType: 'stock_adjustment_request', entityId: id, after: { product: product.name, delta, reason, note: cleanNote, device } });
    notifications.notify({
      storeId: user.storeId, userIds: permissionsService.userIdsWith(user.storeId, 'inventory.approve_adjust', user.id),
      type: 'approval_requested', severity: 'warning',
      title: `${user.name} asked to change ${product.name} stock by ${delta > 0 ? '+' : ''}${delta}`,
      body: `Reason: ${reason.replace(/_/g, ' ')}${cleanNote ? ` - ${cleanNote}` : ''}`,
      entityType: 'approval', entityId: id, dedupeKey: `stock_adjustment_requested:${id}`,
    });
    return { applied: false, approvalId: `stock_adjustment:${id}` };
  }

  const row = apply({ storeId: user.storeId, productId, changeQty: delta, movementReason: REASONS[reason], userId: user.id });
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'inventory', entityId: productId, after: { product: product.name, delta, reason, note: cleanNote, device } });
  securityAlerts.stockAdjusted({ storeId: user.storeId, actor: { id: user.id, name: user.name }, product: product.name, qty: delta, reason });
  return { applied: true, newAvailable: row.quantity };
}

module.exports = { REASONS, apply, adjustFromApp };
