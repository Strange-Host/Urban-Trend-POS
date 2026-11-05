const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/suppliers.service');

// GET /api/suppliers?include_inactive=1
const list = asyncHandler(async (req, res) => {
  res.json(svc.listSuppliers({ query: req.query }));
});

// POST /api/suppliers  { name, phone, email, address, note }
const create = asyncHandler(async (req, res) => {
  res.status(201).json(svc.addSupplier({ body: req.body, user: req.user }));
});

// PUT /api/suppliers/:id — renaming or switching one off is for people who manage products, not the storekeeper.
const update = asyncHandler(async (req, res) => {
  res.json(svc.updateSupplier({ params: req.params, body: req.body, user: req.user }));
});

module.exports = { list, create, update };
