const asyncHandler = require('../utils/asyncHandler');
const settlement = require('../services/deliverySettlement.service');

const ctx = (req) => ({ storeId: req.user.storeId, staffId: req.user.id });

// GET /api/orders/:id/delivery — the settlement: fee charged and collected, every cost, the result.
const get = asyncHandler(async (req, res) => {
  res.json({ data: settlement.get({ orderId: Number(req.params.id), storeId: req.user.storeId }) });
});

// POST /api/orders/:id/delivery/fee-receipts — the customer paid (more of) the delivery fee after dispatch.
const recordFeeReceipt = asyncHandler(async (req, res) => {
  const { amount, method, reference, note } = req.body;
  res.status(201).json({ data: settlement.recordFeeReceipt({ orderId: Number(req.params.id), ...ctx(req), amount, method, reference, note }) });
});

// POST /api/orders/:id/delivery/costs — an extra cost the shop paid, with the reason. Needs a second person's approval.
const recordCost = asyncHandler(async (req, res) => {
  const { kind, amount, reason, paid_via, reference } = req.body;
  res.status(201).json({ data: settlement.recordCost({ orderId: Number(req.params.id), ...ctx(req), kind, amount, reason, paidVia: paid_via, reference }) });
});

// POST /api/orders/:id/delivery/close — confirms the outcome and freezes the figures.
const close = asyncHandler(async (req, res) => {
  res.json({ data: settlement.close({ orderId: Number(req.params.id), ...ctx(req), note: req.body?.note }) });
});

// POST /api/orders/:id/delivery/reopen — administrator only, with a reason.
const reopen = asyncHandler(async (req, res) => {
  res.json({ data: settlement.reopen({ orderId: Number(req.params.id), ...ctx(req), reason: req.body.reason }) });
});

// GET /api/delivery/settlements?status=open|closed&from=&to=&loss_only=1
const list = asyncHandler(async (req, res) => {
  const status = ['open', 'closed'].includes(req.query.status) ? req.query.status : undefined;
  res.json(settlement.list({ storeId: req.user.storeId, status, from: req.query.from, to: req.query.to, lossOnly: req.query.loss_only === '1' }));
});

// GET /api/delivery/costs/pending — the approver's queue.
const pending = asyncHandler(async (req, res) => {
  res.json({ data: settlement.listPendingCosts({ storeId: req.user.storeId }) });
});

const approve = asyncHandler(async (req, res) => {
  res.json({ data: settlement.approveCost({ costId: Number(req.params.costId), ...ctx(req) }) });
});

const reject = asyncHandler(async (req, res) => {
  res.json({ data: settlement.rejectCost({ costId: Number(req.params.costId), ...ctx(req), reason: req.body.reason }) });
});

const reverse = asyncHandler(async (req, res) => {
  res.status(201).json({ data: settlement.reverseCost({ costId: Number(req.params.costId), ...ctx(req), amount: req.body.amount, reason: req.body.reason }) });
});

module.exports = { get, recordFeeReceipt, recordCost, close, reopen, list, pending, approve, reject, reverse };
