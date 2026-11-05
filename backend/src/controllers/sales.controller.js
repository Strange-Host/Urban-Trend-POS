const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/sales.service');

// POST /api/sales  — checkout
const checkout = asyncHandler(async (req, res) => {
  res.status(201).json(svc.checkoutSale({ body: req.body, user: req.user }));
});

// GET /api/sales/discount-limit  — the caller's own cap on discounts (percent, 0 = none)
const discountLimit = asyncHandler(async (req, res) => {
  res.json(svc.discountLimitFor(req.user));
});

// GET /api/sales?from=&to=&cashier_id=&page=&pageSize=
const list = asyncHandler(async (req, res) => {
  res.json(svc.listSales({ query: req.query, user: req.user }));
});

// GET /api/sales/:id
const getById = asyncHandler(async (req, res) => {
  res.json(svc.getSale({ params: req.params, user: req.user }));
});

// POST /api/sales/:id/void  — for someone holding sales.void, restocks items. Anyone else files a request
const voidSale = asyncHandler(async (req, res) => {
  res.json(svc.voidSaleAndResolve({ user: req.user, params: req.params }));
});

module.exports = { checkout, discountLimit, list, getById, voidSale };
