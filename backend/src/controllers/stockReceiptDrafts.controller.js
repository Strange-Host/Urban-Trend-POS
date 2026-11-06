const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/stockReceiptDrafts.service');

// GET /api/stock/receipts/drafts — the caller's drafts (a stock reviewer sees the whole branch's)
const list = asyncHandler(async (req, res) => {
  res.json(svc.listDrafts({ user: req.user }));
});

// GET /api/stock/receipts/drafts/:id
const getOne = asyncHandler(async (req, res) => {
  res.json(svc.getDraft({ params: req.params, user: req.user }));
});

// POST /api/stock/receipts/drafts  { supplier_id?, new_supplier?, reference?, note?, received_on?, items: [...] } — same shape as a receipt, but incomplete is fine
const create = asyncHandler(async (req, res) => {
  res.status(201).json(svc.saveDraft({ user: req.user, params: {}, body: req.body }));
});

// PUT /api/stock/receipts/drafts/:id — replaces the draft's contents
const update = asyncHandler(async (req, res) => {
  res.json(svc.saveDraft({ user: req.user, params: req.params, body: req.body }));
});

// DELETE /api/stock/receipts/drafts/:id
const remove = asyncHandler(async (req, res) => {
  res.json(svc.deleteDraft({ params: req.params, user: req.user }));
});

// POST /api/stock/receipts/drafts/:id/submit — receives it for real (stock goes in now) and removes the draft
const submit = asyncHandler(async (req, res) => {
  res.status(201).json(svc.submitDraft({ params: req.params, user: req.user }));
});

module.exports = { list, getOne, create, update, remove, submit };
