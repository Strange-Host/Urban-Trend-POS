const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/pettyCash.service');

// GET /api/petty-cash — the float's figures plus the latest top-ups and petty-cash spends.
const overview = asyncHandler(async (req, res) => {
  res.json(svc.pettyCashOverview({ user: req.user }));
});

// POST /api/petty-cash/topups  { amount, note, topup_date }
const createTopup = asyncHandler(async (req, res) => {
  res.status(201).json(svc.createTopup({ body: req.body, user: req.user }));
});

const approveTopup = asyncHandler(async (req, res) => {
  res.json(svc.approveTopup({ params: req.params, user: req.user }));
});

const rejectTopup = asyncHandler(async (req, res) => {
  res.json(svc.rejectTopup({ params: req.params, user: req.user, body: req.body }));
});

module.exports = { overview, createTopup, approveTopup, rejectTopup };
