const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/stores.service');

// GET /api/stores — every branch, so screens can offer "send to ..." pickers. Names only: no figures here.
const list = asyncHandler(async (req, res) => {
  res.json(svc.listStores({ user: req.user }));
});

// POST /api/stores  { name, address }  (admin) — adds an outlet. There is only ever one main store.
const create = asyncHandler(async (req, res) => {
  res.status(201).json(svc.createStore({ body: req.body, user: req.user }));
});

// PUT /api/stores/:id  { name?, address?, is_active? }  (admin)
const update = asyncHandler(async (req, res) => {
  res.json(svc.updateStore({ params: req.params, body: req.body, user: req.user }));
});

module.exports = { list, create, update };
