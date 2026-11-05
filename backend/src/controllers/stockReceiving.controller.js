const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/stockReceiving.service');

// GET /api/stock/receipts?from=&to=&supplier_id=&page=&limit=
const listReceipts = asyncHandler(async (req, res) => {
  res.json(svc.listReceipts({ query: req.query, user: req.user }));
});

// GET /api/stock/receipts/:id
const getReceipt = asyncHandler(async (req, res) => {
  res.json(svc.getReceipt({ params: req.params, user: req.user }));
});

// POST /api/stock/receipts
const createReceipt = asyncHandler(async (req, res) => {
  res.status(201).json(svc.createReceipt({ user: req.user, body: req.body }));
});

// GET /api/stock/issues?from=&to=&reason=&page=&limit=
const listIssues = asyncHandler(async (req, res) => {
  res.json(svc.listIssues({ query: req.query, user: req.user }));
});

// POST /api/stock/issues  { product_id, quantity, reason, supplier_id?, note?, issued_on?, batch_id? }
const createIssue = asyncHandler(async (req, res) => {
  res.status(201).json(svc.createIssue({ user: req.user, body: req.body }));
});

module.exports = { listReceipts, getReceipt, createReceipt, listIssues, createIssue };
