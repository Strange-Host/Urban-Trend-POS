const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const reconciliationService = require('../services/reconciliation.service');

// GET /api/inventory
const list = asyncHandler(async (req, res) => {
  const rows = db.prepare(`
    SELECT i.*, p.name AS product_name, p.sku, p.barcode
    FROM inventory i JOIN products p ON p.id = i.product_id
    WHERE i.store_id = ? AND p.is_active = 1
    ORDER BY p.name ASC
  `).all(req.user.storeId);
  res.json({ data: rows });
});

// GET /api/inventory/low-stock
const lowStock = asyncHandler(async (req, res) => {
  const rows = db.prepare(`
    SELECT i.*, p.name AS product_name, p.sku
    FROM inventory i JOIN products p ON p.id = i.product_id
    WHERE i.store_id = ? AND i.quantity <= i.reorder_level AND p.is_active = 1
    ORDER BY i.quantity ASC
  `).all(req.user.storeId);
  res.json({ data: rows });
});

// POST /api/inventory/adjust  { product_id, change_qty, reason, note }
// reason: 'restock' | 'adjustment' | 'return'
const adjust = asyncHandler(async (req, res) => {
  const { product_id, change_qty, reason } = req.body;
  if (!product_id || !change_qty || !reason) {
    throw new ApiError(400, 'product_id, change_qty, and reason are required.');
  }
  if (!Number.isInteger(product_id) || !Number.isInteger(change_qty)) {
    throw new ApiError(400, 'product_id and change_qty must be whole numbers.');
  }
  if (!['restock', 'adjustment', 'return'].includes(reason)) {
    throw new ApiError(400, 'reason must be restock, adjustment, or return.');
  }

  const txn = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM inventory WHERE product_id = ? AND store_id = ?')
      .get(product_id, req.user.storeId);

    if (existing) {
      const newQty = existing.quantity + change_qty;
      if (newQty < 0) throw new ApiError(400, 'Adjustment would result in negative stock.');
      db.prepare(`UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(newQty, existing.id);
    } else {
      if (change_qty < 0) throw new ApiError(400, 'Cannot reduce stock that does not exist yet.');
      db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, ?, ?)')
        .run(product_id, req.user.storeId, change_qty);
    }

    db.prepare(`
      INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(product_id, req.user.storeId, change_qty, reason, req.user.id);

    return db.prepare('SELECT * FROM inventory WHERE product_id = ? AND store_id = ?')
      .get(product_id, req.user.storeId);
  });

  res.json({ data: txn() });
});

// GET /api/inventory/:productId/movements — audit trail for one product
const movements = asyncHandler(async (req, res) => {
  const rows = db.prepare(`
    SELECT m.*, u.name AS user_name
    FROM inventory_movements m LEFT JOIN users u ON u.id = m.created_by
    WHERE m.product_id = ? AND m.store_id = ?
    ORDER BY m.created_at DESC
    LIMIT 100
  `).all(req.params.productId, req.user.storeId);
  res.json({ data: rows });
});

// GET /api/inventory/reconcile — check inventory.quantity against the
// inventory_movements ledger without changing anything.
const checkReconciliation = asyncHandler(async (req, res) => {
  res.json({ data: reconciliationService.findDrift() });
});

// POST /api/inventory/reconcile — fix any drift found, admin-only since it
// overwrites the cached quantity (correct only if the ledger is right).
const runReconciliation = asyncHandler(async (req, res) => {
  res.json({ data: reconciliationService.reconcile() });
});

module.exports = { list, lowStock, adjust, movements, checkReconciliation, runReconciliation };
