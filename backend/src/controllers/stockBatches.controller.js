const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { logStaffAction } = require('../utils/auditLog');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const { dateParam } = require('../utils/storeTime');
const permissionsService = require('../services/permissions.service');
const notifications = require('../services/notifications.service');
const stock = require('../services/stock.service');
const costing = require('../services/costing.service');
const alerts = require('../services/stockAlerts.service');
const { scopeStore } = require('./stockReceiving.controller');

// Batches: expiry, recall, and the buying price of each received batch.

const canSeeCost = (u) => permissionsService.can(u, 'products.view_cost');

// GET /api/stock/batches?status=expired|expiring|recalled|all&store_id=
// Quantities only - a batch's buying price is never in this list.
const listBatches = asyncHandler(async (req, res) => {
  const storeId = scopeStore(req);
  const status = req.query.status || 'all';
  if (!['all', 'expired', 'expiring', 'recalled'].includes(status)) throw new ApiError(400, 'status must be all, expired, expiring or recalled.');
  const rows = costing.batchesByStatus({ storeId, status, today: stock.shopToday(), withinDays: alerts.expiryWindowDays() });
  res.json({ data: rows, expiry_alert_days: alerts.expiryWindowDays() });
});

// GET /api/stock/alerts?store_id= - low stock, expiring / expired / recalled batches and damaged stock in one call.
const getAlerts = asyncHandler(async (req, res) => {
  const storeId = scopeStore(req);
  res.json({ data: alerts.summary({ storeId, canSeeCost: canSeeCost(req.user) }) });
});

// GET /api/stock/damaged?from=&to=&store_id= - stock written off as damaged, plus damaged returns still waiting for a decision.
const listDamaged = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const storeId = scopeStore(req);
  const from = dateParam(req.query.from, 'from', null);
  const to = dateParam(req.query.to, 'to', null);
  const where = ["i.store_id = @storeId", "i.reason = 'damaged'"];
  const params = { storeId };
  if (from) { where.push('i.issued_on >= @from'); params.from = from; }
  if (to) { where.push('i.issued_on <= @to'); params.to = to; }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const rows = db.prepare(`
    SELECT i.id, i.product_id, i.quantity, i.note, i.issued_on, i.batch_id, p.name AS product_name, p.sku, u.name AS issued_by_name
    FROM stock_issues i JOIN products p ON p.id = i.product_id JOIN users u ON u.id = i.issued_by_staff_id
    ${whereSql} ORDER BY i.issued_on DESC, i.id DESC LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });
  const totals = db.prepare(`SELECT COUNT(*) AS issues, COALESCE(SUM(quantity), 0) AS units FROM stock_issues i ${whereSql}`).get(params);
  if (canSeeCost(req.user)) {
    const costs = costing.costOfIssues(rows);
    for (const r of rows) r.cost_value = costs.get(r.id) || 0;
  }
  const awaiting = db.prepare(`
    SELECT COUNT(*) AS c FROM orders WHERE store_id = ? AND status = 'returned_damaged' AND owner_decision IS NULL AND deleted_at IS NULL
  `).get(storeId).c;
  res.json({ ...paginatedResponse({ rows, total: totals.issues, page, limit }), totals: { ...totals, returns_awaiting_decision: awaiting } });
});

// ---- buying price per batch ----------------------------------------------------------------------------------------
// Receiving hides buying prices from the storekeeper, so a batch arrives without one. Whoever approves buying prices
// (admin / manager) fills it in here, and that cost is what FIFO / average valuation and the cost of each later sale use.

function requireCostingRights(user) {
  if (!canSeeCost(user) || !permissionsService.can(user, 'stock.review')) {
    throw new ApiError(403, 'You do not have permission to set buying prices.', null, 'FORBIDDEN');
  }
}

// GET /api/stock/receipts/awaiting-cost - received batches of approved products that still have no buying price.
const listAwaitingCost = asyncHandler(async (req, res) => {
  requireCostingRights(req.user);
  const storeId = scopeStore(req);
  const rows = db.prepare(`
    SELECT i.id AS item_id, i.receipt_id, i.quantity, i.batch_no, i.expiry_date, r.received_on, r.reference, s.name AS supplier_name,
           p.id AS product_id, p.name AS product_name, p.sku, p.cost_price AS catalog_cost
    FROM stock_receipt_items i
    JOIN stock_receipts r ON r.id = i.receipt_id
    JOIN products p ON p.id = i.product_id
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    WHERE r.store_id = ? AND i.unit_cost IS NULL AND p.approval_status = 'approved'
    ORDER BY r.received_on DESC, i.id DESC LIMIT 500
  `).all(storeId);
  res.json({ data: rows });
});

// PUT /api/stock/receipts/:id/costs  { items: [ { item_id, unit_cost } ], update_product_cost?: boolean }
// unit_cost is whole cents per unit. update_product_cost also makes the newest costed batch the product's catalog cost.
const setCosts = asyncHandler(async (req, res) => {
  requireCostingRights(req.user);
  const receipt = db.prepare('SELECT * FROM stock_receipts WHERE id = ?').get(req.params.id);
  if (!receipt || (receipt.store_id !== req.user.storeId && req.user.role !== 'admin')) throw new ApiError(404, 'Receipt not found.');
  const lines = Array.isArray(req.body?.items) ? req.body.items : [];
  if (lines.length === 0) throw new ApiError(400, 'Give at least one item with its unit_cost.');

  const changes = [];
  db.transaction(() => {
    for (const [idx, line] of lines.entries()) {
      const where = `Line ${idx + 1}`;
      if (!Number.isInteger(line.unit_cost) || line.unit_cost < 0) throw new ApiError(400, `${where}: unit_cost must be a whole number of cents, zero or more.`);
      const item = db.prepare('SELECT id, product_id, unit_cost FROM stock_receipt_items WHERE id = ? AND receipt_id = ?').get(line.item_id, receipt.id);
      if (!item) throw new ApiError(404, `${where}: that item is not on this receipt.`);
      db.prepare(`UPDATE stock_receipt_items SET unit_cost = ?, costed_by_staff_id = ?, costed_at = datetime('now') WHERE id = ?`).run(line.unit_cost, req.user.id, item.id);
      changes.push({ item_id: item.id, product_id: item.product_id, before: item.unit_cost, after: line.unit_cost });
    }
    if (req.body.update_product_cost) {
      for (const productId of new Set(changes.map((c) => c.product_id))) {
        const newest = db.prepare(`
          SELECT i.unit_cost FROM stock_receipt_items i JOIN stock_receipts r ON r.id = i.receipt_id
          WHERE i.product_id = ? AND i.unit_cost IS NOT NULL ORDER BY r.received_on DESC, i.id DESC LIMIT 1
        `).get(productId);
        if (newest) db.prepare(`UPDATE products SET cost_price = ?, updated_at = datetime('now') WHERE id = ?`).run(newest.unit_cost, productId);
      }
    }
  })();
  logStaffAction({ staffId: req.user.id, action: 'update', entityType: 'stock_receipt_cost', entityId: receipt.id, after: { items: changes } });
  res.json({ data: { receipt_id: receipt.id, costed: changes.length } });
});

// ---- recall --------------------------------------------------------------------------------------------------------
// POST /api/stock/batches/:id/recall  { note }
// Flags the batch as recalled and takes every unit of it still on a shelf (main store or an outlet it was transferred to)
// out of sellable stock, so it cannot be sold. Units already sold are reported back so customers can be reached.
const recallBatch = asyncHandler(async (req, res) => {
  const user = req.user;
  const batch = db.prepare(`
    SELECT i.*, r.store_id AS received_store_id, p.name AS product_name, p.sku
    FROM stock_receipt_items i JOIN stock_receipts r ON r.id = i.receipt_id JOIN products p ON p.id = i.product_id WHERE i.id = ?
  `).get(req.params.id);
  if (!batch || (batch.received_store_id !== user.storeId && user.role !== 'admin')) throw new ApiError(404, 'Batch not found.');
  if (batch.recalled_at) throw new ApiError(409, 'This batch has already been recalled.');
  const note = stock.trimmed(req.body?.note);
  if (!note) throw new ApiError(400, 'Say what the recall is about (note is required).');

  const run = costing.replay(batch.product_id);
  const held = [];
  for (const [storeId, state] of run.stores) {
    const qty = state.layers.filter((l) => l.batchId === batch.id).reduce((n, l) => n + l.qty, 0);
    if (qty > 0) held.push({ storeId, qty });
  }

  const today = stock.shopToday();
  db.transaction(() => {
    db.prepare(`UPDATE stock_receipt_items SET recalled_at = datetime('now'), recalled_by_staff_id = ?, recall_note = ? WHERE id = ?`).run(user.id, note, batch.id);
    for (const h of held) {
      const issueId = db.prepare(`
        INSERT INTO stock_issues (store_id, product_id, quantity, reason, note, issued_on, issued_by_staff_id, batch_id)
        VALUES (?, ?, ?, 'recalled', ?, ?, ?, ?)
      `).run(h.storeId, batch.product_id, h.qty, note, today, user.id, batch.id).lastInsertRowid;
      stock.applyMovement({ productId: batch.product_id, storeId: h.storeId, change: -h.qty, reason: 'issue', referenceType: 'issue', referenceId: issueId, userId: user.id, batchId: batch.id });
    }
  })();

  const pulled = held.reduce((n, h) => n + h.qty, 0);
  const afterRun = costing.batchRows({}).find((r) => r.batch_id === batch.id);
  const result = {
    batch_id: batch.id, product_id: batch.product_id, product_name: batch.product_name, batch_no: batch.batch_no,
    received_qty: batch.quantity, pulled_from_shelves: pulled, already_left_stock: afterRun ? afterRun.units_gone : batch.quantity - pulled,
    stores: held.map((h) => ({ store_id: h.storeId, quantity: h.qty })),
  };
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'stock_batch', entityId: batch.id, after: { recalled: true, ...result, note } });

  for (const storeId of new Set([batch.received_store_id, ...held.map((h) => h.storeId)])) {
    notifications.notify({
      storeId, roles: ['admin', 'manager'], type: 'batch_recalled', severity: 'urgent',
      title: `Recall: ${batch.product_name}${batch.batch_no ? ` (batch ${batch.batch_no})` : ''}`,
      body: `${pulled} unit(s) taken off sale. ${result.already_left_stock} had already left stock. ${note}`,
      entityType: 'stock_batch', entityId: batch.id, dedupeKey: `batch_recalled:${batch.id}`,
    });
  }
  res.status(201).json({ data: result });
});

module.exports = { listBatches, getAlerts, listDamaged, listAwaitingCost, setCosts, recallBatch };
