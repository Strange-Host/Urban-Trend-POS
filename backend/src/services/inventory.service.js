const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const reconciliationService = require('./reconciliation.service');
const stock = require('./stock.service');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const { scopeStore } = require('./stockReceiving.service');

// The stock-count screen needs EVERY active product in one go, so these two lists stay "everything" by default - but
// never unbounded: past INVENTORY_LIST_CAP rows the response is cut and says so (`truncated: true`) instead of
// growing with the catalog forever. Callers that want pages pass ?page= / ?limit= (max 100, the shared pagination).
const INVENTORY_LIST_CAP = 5000;

function inventoryList(query, { select, from, orderBy, params }) {
  const wantsPages = query.page !== undefined || query.limit !== undefined;
  if (wantsPages) {
    const { page, limit, offset } = parsePagination(query);
    const rows = db.prepare(`${select} ${from} ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS c ${from}`).get(...params).c;
    return paginatedResponse({ rows, total, page, limit });
  }
  const rows = db.prepare(`${select} ${from} ${orderBy} LIMIT ?`).all(...params, INVENTORY_LIST_CAP + 1);
  const truncated = rows.length > INVENTORY_LIST_CAP;
  return { data: truncated ? rows.slice(0, INVENTORY_LIST_CAP) : rows, truncated };
}

// GET /api/inventory   (optional ?page=&limit=)
function listInventory({ query, user }) {
  return inventoryList(query, {
    select: 'SELECT i.*, p.name AS product_name, p.sku, p.barcode',
    from: 'FROM inventory i JOIN products p ON p.id = i.product_id WHERE i.store_id = ? AND p.is_active = 1',
    orderBy: 'ORDER BY p.name ASC',
    params: [user.storeId],
  });
}

// GET /api/inventory/low-stock   (optional ?page=&limit=)
function listLowStock({ query, user }) {
  return inventoryList(query, {
    select: 'SELECT i.*, p.name AS product_name, p.sku',
    from: 'FROM inventory i JOIN products p ON p.id = i.product_id WHERE i.store_id = ? AND i.quantity <= i.reorder_level AND p.is_active = 1',
    orderBy: 'ORDER BY i.quantity ASC',
    params: [user.storeId],
  });
}

// POST /api/inventory/adjust  { product_id, change_qty, reason, note }
// reason: 'restock' | 'adjustment' | 'return'
function adjustStock({ body, user }) {
  const { product_id, change_qty, reason } = body;
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
    stock.applyMovement({
      productId: product_id, storeId: user.storeId, change: change_qty, reason, userId: user.id,
      shortfall: ({ hadRow }) => new ApiError(400, hadRow ? 'Adjustment would result in negative stock.' : 'Cannot reduce stock that does not exist yet.'),
    });
    return stock.inventoryRow(product_id, user.storeId);
  });

  const result = txn();
  const product = db.prepare('SELECT name FROM products WHERE id = ?').get(product_id);
  require('./securityAlerts.service').stockAdjusted({
    storeId: user.storeId, actor: { id: user.id, name: user.name }, product: product?.name, qty: change_qty, reason,
  });
  return { data: result };
}

// GET /api/inventory/:productId/movements?store_id=&page=&limit= — audit trail for one product, newest first.
// Your own branch unless you can review stock and name another (same rule as the other stock lists).
function listMovements({ params, query, user }) {
  const productId = Number(params.productId);
  if (!Number.isInteger(productId) || productId < 1) throw new ApiError(400, 'productId must be a whole number.');
  const { page, limit, offset } = parsePagination(query);
  const storeId = scopeStore(user, query);
  const rows = db.prepare(`
    SELECT m.*, u.name AS user_name
    FROM inventory_movements m LEFT JOIN users u ON u.id = m.created_by
    WHERE m.product_id = ? AND m.store_id = ?
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ? OFFSET ?
  `).all(productId, storeId, limit, offset);
  const total = db.prepare('SELECT COUNT(*) AS c FROM inventory_movements WHERE product_id = ? AND store_id = ?').get(productId, storeId).c;
  return paginatedResponse({ rows, total, page, limit });
}

// GET /api/inventory/reconcile — check inventory.quantity against the
// inventory_movements ledger without changing anything.
function checkReconciliation() {
  return { data: reconciliationService.findDrift() };
}

// POST /api/inventory/reconcile — fix any drift found, admin-only since it
// overwrites the cached quantity (correct only if the ledger is right).
function runReconciliation() {
  return { data: reconciliationService.reconcile() };
}

module.exports = { listInventory, listLowStock, adjustStock, listMovements, checkReconciliation, runReconciliation };
