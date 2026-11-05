const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/categories.service');

// GET /api/categories?include_archived=1
const list = asyncHandler(async (req, res) => {
  res.json(svc.listCategories({ query: req.query }));
});

const create = asyncHandler(async (req, res) => {
  res.status(201).json(svc.createCategory({ body: req.body }));
});

const update = asyncHandler(async (req, res) => {
  res.json(svc.updateCategory({ body: req.body, params: req.params }));
});

// GET /api/categories/:id/usage - what would be affected by deleting this category
const usage = asyncHandler(async (req, res) => {
  res.json(svc.categoryUsage({ params: req.params }));
});

// DELETE /api/categories/:id?move_to=<category id>
const remove = asyncHandler(async (req, res) => {
  res.json(svc.removeCategory({ params: req.params, query: req.query, user: req.user }));
});

// POST /api/categories/:id/archive
const archive = asyncHandler(async (req, res) => {
  res.json(svc.archiveCategory({ params: req.params, user: req.user }));
});

// POST /api/categories/:id/restore
const restore = asyncHandler(async (req, res) => {
  res.json(svc.restoreCategory({ params: req.params, user: req.user }));
});

module.exports = { list, create, update, usage, remove, archive, restore };
