const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const { logStaffAction } = require('../utils/auditLog');

// GET /api/expense-categories — lookup table (not a hardcoded enum) so new
// categories can be added without a migration (§3.1 recommendation).
const listCategories = asyncHandler(async (req, res) => {
  const rows = db.prepare('SELECT * FROM expense_categories ORDER BY name ASC').all();
  res.json({ data: rows });
});

const createCategory = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) throw new ApiError(400, 'name is required.');
  const result = db.prepare('INSERT INTO expense_categories (name) VALUES (?)').run(name);
  res.status(201).json({ data: { id: result.lastInsertRowid, name } });
});

// GET /api/expenses?category=&from=&to=&page=&limit=
const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const where = ['e.deleted_at IS NULL', 'e.store_id = ?'];
  const params = [req.user.storeId];
  if (req.query.category) { where.push('e.category_id = ?'); params.push(req.query.category); }
  if (req.query.from) { where.push('e.expense_date >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('e.expense_date <= ?'); params.push(req.query.to); }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT e.*, c.name AS category_name, u.name AS recorded_by_name
    FROM expenses e
    JOIN expense_categories c ON c.id = e.category_id
    JOIN users u ON u.id = e.recorded_by_staff_id
    ${whereSql}
    ORDER BY e.expense_date DESC, e.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM expenses e ${whereSql}`).get(...params).c;

  res.json(paginatedResponse({ rows, total, page, limit }));
});

// GET /api/expenses/summary?from=&to=  — totals by category, for Dashboard/reporting
const summary = asyncHandler(async (req, res) => {
  const where = ['e.deleted_at IS NULL', 'e.store_id = ?'];
  const params = [req.user.storeId];
  if (req.query.from) { where.push('e.expense_date >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('e.expense_date <= ?'); params.push(req.query.to); }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const byCategory = db.prepare(`
    SELECT c.id AS category_id, c.name AS category_name, SUM(e.amount) AS total
    FROM expenses e JOIN expense_categories c ON c.id = e.category_id
    ${whereSql}
    GROUP BY c.id, c.name
    ORDER BY total DESC
  `).all(...params);
  const grandTotal = db.prepare(`SELECT COALESCE(SUM(e.amount), 0) t FROM expenses e ${whereSql}`).get(...params).t;

  res.json({ data: { grand_total: grandTotal, by_category: byCategory } });
});

const getById = asyncHandler(async (req, res) => {
  const expense = db.prepare('SELECT * FROM expenses WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.user.storeId);
  if (!expense) throw new ApiError(404, 'Expense not found.');
  res.json({ data: expense });
});

// POST /api/expenses  { category_id, amount, description, expense_date, receipt_url }
const create = asyncHandler(async (req, res) => {
  const { category_id, amount, description, expense_date, receipt_url } = req.body;

  const category = db.prepare('SELECT id FROM expense_categories WHERE id = ?').get(category_id);
  if (!category) throw new ApiError(400, 'Unknown category_id.');

  const result = db.prepare(`
    INSERT INTO expenses (store_id, category_id, amount, description, expense_date, recorded_by_staff_id, receipt_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.storeId, category_id, amount, description || null, expense_date, req.user.id, receipt_url || null);

  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId: req.user.id, action: 'create', entityType: 'expense', entityId: expense.id, after: expense });
  res.status(201).json({ data: expense });
});

// PATCH /api/expenses/:id
const update = asyncHandler(async (req, res) => {
  const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.user.storeId);
  if (!existing) throw new ApiError(404, 'Expense not found.');

  const category_id = req.body.category_id ?? existing.category_id;
  const amount = req.body.amount ?? existing.amount;
  const description = req.body.description ?? existing.description;
  const expense_date = req.body.expense_date ?? existing.expense_date;
  const receipt_url = req.body.receipt_url ?? existing.receipt_url;

  if (req.body.category_id !== undefined) {
    const category = db.prepare('SELECT id FROM expense_categories WHERE id = ?').get(category_id);
    if (!category) throw new ApiError(400, 'Unknown category_id.');
  }

  db.prepare(`
    UPDATE expenses SET category_id=?, amount=?, description=?, expense_date=?, receipt_url=?, updated_at=datetime('now')
    WHERE id=?
  `).run(category_id, amount, description, expense_date, receipt_url, req.params.id);

  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  logStaffAction({ staffId: req.user.id, action: 'update', entityType: 'expense', entityId: expense.id, before: existing, after: expense });
  res.json({ data: expense });
});

// DELETE /api/expenses/:id — soft delete
const remove = asyncHandler(async (req, res) => {
  const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.user.storeId);
  if (!existing) throw new ApiError(404, 'Expense not found.');

  db.prepare(`UPDATE expenses SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  logStaffAction({ staffId: req.user.id, action: 'delete', entityType: 'expense', entityId: existing.id, before: existing });
  res.status(204).send();
});

module.exports = { list, summary, getById, create, update, remove, listCategories, createCategory };
