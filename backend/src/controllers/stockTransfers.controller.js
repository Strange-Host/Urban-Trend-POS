const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/stockTransfers.service');

// GET /api/stock/transfers?status=&page=&limit=
const list = asyncHandler(async (req, res) => {
  res.json(svc.listTransfers({ query: req.query, user: req.user }));
});

// GET /api/stock/transfers/:id
const getOne = asyncHandler(async (req, res) => {
  res.json(svc.getTransfer({ params: req.params, user: req.user }));
});

// POST /api/stock/transfers  { to_store_id, from_store_id?, note?, items: [{ product_id, quantity }] }
const create = asyncHandler(async (req, res) => {
  res.status(201).json(svc.createTransfer({ user: req.user, body: req.body }));
});

// POST /api/stock/transfers/:id/approve — moves the stock.
const approve = asyncHandler(async (req, res) => {
  res.json(svc.approveTransfer({ params: req.params, user: req.user }));
});

// POST /api/stock/transfers/:id/reject  { note }
const reject = asyncHandler(async (req, res) => {
  res.json(svc.rejectTransfer({ params: req.params, user: req.user, body: req.body }));
});

// POST /api/stock/transfers/:id/cancel — the requester withdraws it (or an admin does).
const cancel = asyncHandler(async (req, res) => {
  res.json(svc.cancelTransfer({ params: req.params, user: req.user }));
});

module.exports = { list, getOne, create, approve, reject, cancel };
