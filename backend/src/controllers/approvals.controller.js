const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const approvalsService = require('../services/approvals.service');

// GET /api/approvals?status=pending|closed&mine=1&page=&limit=
// A reviewer sees the store's requests; anyone else only the ones they filed.
const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const status = ['pending', 'closed'].includes(req.query.status) ? req.query.status : undefined;
  const { rows, total, pending } = approvalsService.list({ user: req.user, status, mine: req.query.mine === '1', limit, offset });
  res.json({ ...paginatedResponse({ rows, total, page, limit }), pending });
});

// POST /api/approvals  { kind: 'void_sale', sale_id, reason }  or  { kind: 'refund_payment', payment_id, reason }
const create = asyncHandler(async (req, res) => {
  const { kind, sale_id, payment_id, reason } = req.body;
  const row = approvalsService.create({ user: req.user, kind, saleId: sale_id, paymentId: payment_id, reason });
  res.status(201).json({ data: row });
});

// POST /api/approvals/:id/approve — runs the void / refund
const approve = asyncHandler(async (req, res) => {
  res.json({ data: approvalsService.approve({ id: Number(req.params.id), reviewer: req.user }) });
});

// POST /api/approvals/:id/reject  { note }
const reject = asyncHandler(async (req, res) => {
  res.json({ data: approvalsService.reject({ id: Number(req.params.id), reviewer: req.user, note: req.body.note }) });
});

// POST /api/approvals/:id/cancel — the person who filed it withdraws it
const cancel = asyncHandler(async (req, res) => {
  res.json({ data: approvalsService.cancel({ id: Number(req.params.id), user: req.user }) });
});

module.exports = { list, create, approve, reject, cancel };
