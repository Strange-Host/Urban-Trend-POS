const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/requisitions.service');

// GET /api/requisitions?status=&requested_by=&page=&limit=
const list = asyncHandler(async (req, res) => {
  res.json(svc.listRequisitions({ query: req.query, user: req.user }));
});

// GET /api/requisitions/:id
const getById = asyncHandler(async (req, res) => {
  res.json(svc.getRequisition({ params: req.params, user: req.user }));
});

// POST /api/requisitions
const create = asyncHandler(async (req, res) => {
  res.status(201).json(svc.createRequisition({ body: req.body, user: req.user }));
});

// PATCH /api/requisitions/:id/approve  { items: [{ product_id, quantity_approved }] }
const approve = asyncHandler(async (req, res) => {
  res.json(svc.approveRequisition({ params: req.params, body: req.body, user: req.user }));
});

// PATCH /api/requisitions/:id/reject  { rejection_reason }
const reject = asyncHandler(async (req, res) => {
  res.json(svc.rejectRequisition({ body: req.body, params: req.params, user: req.user }));
});

// PATCH /api/requisitions/:id/acknowledge  { signed_name }
const acknowledgeReceipt = asyncHandler(async (req, res) => {
  res.json(svc.acknowledgeReceipt({ params: req.params, user: req.user, body: req.body }));
});

module.exports = { list, getById, create, approve, reject, acknowledgeReceipt };
