const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/expenses.service');

// GET /api/expense-categories — lookup table (not a hardcoded enum) so new
const listCategories = asyncHandler(async (req, res) => {
  res.json(svc.listExpenseCategories());
});

const createCategory = asyncHandler(async (req, res) => {
  res.status(201).json(svc.createExpenseCategory({ body: req.body }));
});

// GET /api/expenses?category=&status=&paid_from=&from=&to=&page=&limit=
const list = asyncHandler(async (req, res) => {
  res.json(svc.listExpenses({ query: req.query, user: req.user }));
});

// GET /api/expenses/summary?from=&to=  — totals by category, for Dashboard/reporting.
const summary = asyncHandler(async (req, res) => {
  res.json(svc.expenseSummary({ user: req.user, query: req.query }));
});

const getById = asyncHandler(async (req, res) => {
  res.json(svc.getExpense({ params: req.params, user: req.user }));
});

// POST /api/expenses  { category_id, amount, description, expense_date, receipt_url, paid_from }
const create = asyncHandler(async (req, res) => {
  res.status(201).json(svc.createExpense({ body: req.body, user: req.user }));
});

// PATCH /api/expenses/:id
const update = asyncHandler(async (req, res) => {
  res.json(svc.updateExpense({ params: req.params, user: req.user, body: req.body }));
});

// POST /api/expenses/:id/approve
const approve = asyncHandler(async (req, res) => {
  res.json(svc.approveExpense({ params: req.params, user: req.user }));
});

// POST /api/expenses/:id/reject  { note }
const reject = asyncHandler(async (req, res) => {
  res.json(svc.rejectExpense({ params: req.params, user: req.user, body: req.body }));
});

// DELETE /api/expenses/:id — soft delete. An approved expense is part of the books, so only an admin can remove it.
const remove = asyncHandler(async (req, res) => {
  svc.removeExpense({ params: req.params, user: req.user });
  res.status(204).send();
});

module.exports = { listCategories, createCategory, list, summary, getById, create, update, approve, reject, remove };
