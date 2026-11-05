const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/stockBatches.service');

// GET /api/stock/batches?status=expired|expiring|recalled|all&store_id=
const listBatches = asyncHandler(async (req, res) => {
  res.json(svc.listBatches({ user: req.user, query: req.query }));
});

// GET /api/stock/alerts?store_id= - low stock, expiring / expired / recalled batches and damaged stock in one call.
const getAlerts = asyncHandler(async (req, res) => {
  res.json(svc.getAlerts({ user: req.user, query: req.query }));
});

// GET /api/stock/damaged?from=&to=&store_id= - stock written off as damaged, plus damaged returns still waiting for a decision.
const listDamaged = asyncHandler(async (req, res) => {
  res.json(svc.listDamaged({ query: req.query, user: req.user }));
});

// GET /api/stock/receipts/awaiting-cost - received batches of approved products that still have no buying price.
const listAwaitingCost = asyncHandler(async (req, res) => {
  res.json(svc.listAwaitingCost({ user: req.user, query: req.query }));
});

// PUT /api/stock/receipts/:id/costs  { items: [ { item_id, unit_cost } ], update_product_cost?: boolean }
const setCosts = asyncHandler(async (req, res) => {
  res.json(svc.setCosts({ user: req.user, params: req.params, body: req.body }));
});

// POST /api/stock/batches/:id/recall  { note }
const recallBatch = asyncHandler(async (req, res) => {
  res.status(201).json(svc.recallBatch({ user: req.user, params: req.params, body: req.body }));
});

module.exports = { listBatches, getAlerts, listDamaged, listAwaitingCost, setCosts, recallBatch };
