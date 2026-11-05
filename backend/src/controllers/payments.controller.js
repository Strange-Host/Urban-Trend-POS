const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/payments.service');

// GET /api/payments?direction=&method=&status=&from=&to=&page=&limit=
const list = asyncHandler(async (req, res) => {
  res.json(svc.listPayments({ query: req.query, user: req.user }));
});

// GET /api/payments/summary?from=&to= — totals by method
const summary = asyncHandler(async (req, res) => {
  res.json(svc.paymentsSummary({ user: req.user, query: req.query }));
});

// POST /api/payments  { direction, sale_id?, supplier_name?, method, amount, reference?, notes? }
const create = asyncHandler(async (req, res) => {
  res.status(201).json(svc.createPayment({ body: req.body, user: req.user }));
});

// POST /api/payments/:id/refund — for someone holding payments.refund. Anyone else files a request
const refund = asyncHandler(async (req, res) => {
  res.json(svc.refundPayment({ params: req.params, user: req.user }));
});

module.exports = { list, summary, create, refund };
