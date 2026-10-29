const asyncHandler = require('../utils/asyncHandler');
const payables = require('../services/courierPayables.service');

const ctx = (req) => ({ storeId: req.user.storeId, staffId: req.user.id });
const idOf = (v) => (v === undefined ? undefined : Number(v));

// GET /api/couriers/payables — who is owed what (fees and costs shown separately)
const summary = asyncHandler(async (req, res) => {
  res.json({ data: payables.summary({ storeId: req.user.storeId }) });
});

// GET /api/couriers/:id/payables — one courier's balance with every unpaid item
const balance = asyncHandler(async (req, res) => {
  res.json({ data: payables.balance({ courierId: Number(req.params.id), storeId: req.user.storeId }) });
});

// GET /api/couriers/costs?status=pending&courier_id=
const listCosts = asyncHandler(async (req, res) => {
  res.json({ data: payables.listCosts({ storeId: req.user.storeId, courierId: idOf(req.query.courier_id), status: req.query.status }) });
});

// POST /api/couriers/:id/costs
const recordCost = asyncHandler(async (req, res) => {
  const { kind, amount, description, order_id, receipt_ref } = req.body;
  const row = payables.recordCost({
    ...ctx(req), courierId: Number(req.params.id), kind, amount, description, orderId: order_id, receiptRef: receipt_ref,
  });
  res.status(201).json({ data: row });
});

// POST /api/couriers/costs/:costId/approve
const approveCost = asyncHandler(async (req, res) => {
  res.json({ data: payables.approveCost({ ...ctx(req), costId: Number(req.params.costId) }) });
});

// POST /api/couriers/costs/:costId/reject
const rejectCost = asyncHandler(async (req, res) => {
  res.json({ data: payables.rejectCost({ ...ctx(req), costId: Number(req.params.costId), reason: req.body.reason }) });
});

// POST /api/couriers/:id/payouts
const createPayout = asyncHandler(async (req, res) => {
  const { method, payment_ref, items } = req.body;
  res.status(201).json({ data: payables.createPayout({ ...ctx(req), courierId: Number(req.params.id), method, paymentRef: payment_ref, items }) });
});

// GET /api/couriers/payouts?courier_id=
const listPayouts = asyncHandler(async (req, res) => {
  res.json({ data: payables.listPayouts({ storeId: req.user.storeId, courierId: idOf(req.query.courier_id) }) });
});

// GET /api/couriers/payouts/:payoutId — fee lines and cost lines separately
const getPayout = asyncHandler(async (req, res) => {
  res.json({ data: payables.getPayout({ payoutId: Number(req.params.payoutId), storeId: req.user.storeId }) });
});

module.exports = { summary, balance, listCosts, recordCost, approveCost, rejectCost, createPayout, listPayouts, getPayout };
