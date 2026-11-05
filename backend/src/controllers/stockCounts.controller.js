const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/stockCounts.service');

// GET /api/stock/counts?store_id=&date=&kind=&status=&page=&limit=
const list = asyncHandler(async (req, res) => {
  res.json(svc.listCounts({ query: req.query, user: req.user }));
});

// GET /api/stock/counts/:id
const getOne = asyncHandler(async (req, res) => {
  res.json(svc.getCount({ params: req.params, user: req.user }));
});

// POST /api/stock/counts  { kind: 'opening'|'closing', count_date?, note?, items: [{ product_id, counted_qty }] }
const submit = asyncHandler(async (req, res) => {
  res.status(201).json(svc.submitCount({ user: req.user, body: req.body }));
});

// POST /api/stock/counts/:id/approve  { note?, apply_adjustments? }
const approve = asyncHandler(async (req, res) => {
  res.json(svc.approveCount({ params: req.params, user: req.user, body: req.body }));
});

// POST /api/stock/counts/:id/reject  { note }
const reject = asyncHandler(async (req, res) => {
  res.json(svc.rejectCount({ params: req.params, user: req.user, body: req.body }));
});

// GET /api/stock/counts/day-summary?store_id=&date=
const daySummary = asyncHandler(async (req, res) => {
  res.json(svc.daySummary({ user: req.user, query: req.query }));
});

// GET /api/stock/activity?store_id=&staff_id=&from=&to=&include_sales=1&limit=
const activity = asyncHandler(async (req, res) => {
  res.json(svc.activity({ user: req.user, query: req.query }));
});

module.exports = { list, getOne, submit, approve, reject, daySummary, activity };
