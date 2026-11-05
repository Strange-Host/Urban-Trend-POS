const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/products.service');

// GET /api/products?q=&category_id=&page=1&pageSize=25
const list = asyncHandler(async (req, res) => {
  res.json(svc.listProducts({ query: req.query, user: req.user }));
});

// GET /api/products/barcode/:code  — fast lookup for scanner input at checkout
const getByBarcode = asyncHandler(async (req, res) => {
  res.json(svc.getProductByBarcode({ params: req.params, user: req.user }));
});

// GET /api/products/:id
const getById = asyncHandler(async (req, res) => {
  res.json(svc.getProduct({ params: req.params, user: req.user }));
});

// POST /api/products
const create = asyncHandler(async (req, res) => {
  res.status(201).json(svc.createProduct({ body: req.body, user: req.user }));
});

// GET /api/products/pending/list — proposals waiting for a decision (approvers), or the caller's own proposals.
const listPending = asyncHandler(async (req, res) => {
  res.json(svc.listPendingProducts({ user: req.user }));
});

// POST /api/products/:id/approve  { cost_price?, sell_price? } — the approver may fill in the buying price here.
const approve = asyncHandler(async (req, res) => {
  res.json(svc.approveProduct({ params: req.params, user: req.user, body: req.body }));
});

// POST /api/products/:id/reject  { note } — a reason is required so the storekeeper knows what to fix.
const reject = asyncHandler(async (req, res) => {
  res.json(svc.rejectProduct({ params: req.params, body: req.body, user: req.user }));
});

// PUT /api/products/:id
const update = asyncHandler(async (req, res) => {
  res.json(svc.updateProduct({ params: req.params, user: req.user, body: req.body }));
});

// DELETE /api/products/:id  (soft delete — never hard-delete sold products, breaks sales history)
const remove = asyncHandler(async (req, res) => {
  svc.removeProduct({ params: req.params });
  res.status(204).send();
});

// POST /api/products/:id/catalogue  { catalogue: 'shop' | 'online', opening_stock?, clear_stock? }
const setCatalogue = asyncHandler(async (req, res) => {
  res.json(svc.setCatalogue({ params: req.params, body: req.body, user: req.user }));
});

module.exports = { list, getByBarcode, getById, create, listPending, approve, reject, update, remove, setCatalogue };
