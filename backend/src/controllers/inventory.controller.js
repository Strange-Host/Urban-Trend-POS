const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/inventory.service');

// GET /api/inventory   (optional ?page=&limit=)
const list = asyncHandler(async (req, res) => {
  res.json(svc.listInventory({ query: req.query, user: req.user }));
});

// GET /api/inventory/low-stock   (optional ?page=&limit=)
const lowStock = asyncHandler(async (req, res) => {
  res.json(svc.listLowStock({ query: req.query, user: req.user }));
});

// POST /api/inventory/adjust  { product_id, change_qty, reason, note }
const adjust = asyncHandler(async (req, res) => {
  res.json(svc.adjustStock({ body: req.body, user: req.user }));
});

// GET /api/inventory/:productId/movements?store_id=&page=&limit= — audit trail for one product, newest first.
const movements = asyncHandler(async (req, res) => {
  res.json(svc.listMovements({ params: req.params, query: req.query, user: req.user }));
});

// GET /api/inventory/reconcile — check inventory.quantity against the
const checkReconciliation = asyncHandler(async (req, res) => {
  res.json(svc.checkReconciliation());
});

// POST /api/inventory/reconcile — fix any drift found, admin-only since it
const runReconciliation = asyncHandler(async (req, res) => {
  res.json(svc.runReconciliation());
});

module.exports = { list, lowStock, adjust, movements, checkReconciliation, runReconciliation };
