const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const { logStaffAction } = require('../utils/auditLog');
const notifications = require('../services/notifications.service');
const { floatFigures } = require('../services/pettyCash.service');

// Approval workflow
//   - An expense recorded by an admin is approved on the spot (the admin is the final authority).
//   - Anyone else's starts 'pending' and does not count towards totals or profit until another person with
//     'expenses.approve' approves it. Nobody can approve their own entry.
//   - Editing a rejected expense sends it back for a fresh decision; a non-admin editing an APPROVED one does too,
//     so an amount can't be quietly changed after it was signed off.
//   - Only an admin can delete an approved expense; everyone else can only withdraw pending/rejected ones.
const isAdmin = (user) => user.role === 'admin';

const LIST_SQL = `
  SELECT e.*, c.name AS category_name, u.name AS recorded_by_name, r.name AS reviewed_by_name,
    rq.requested_by_staff_id AS requisition_requester_id, rqu.name AS requisition_requester_name
  FROM expenses e
  LEFT JOIN requisitions rq ON rq.id = e.requisition_id
  LEFT JOIN users rqu ON rqu.id = rq.requested_by_staff_id
  JOIN expense_categories c ON c.id = e.category_id
  JOIN users u ON u.id = e.recorded_by_staff_id
  LEFT JOIN users r ON r.id = e.reviewed_by_staff_id
`;

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

// GET /api/expenses?category=&status=&paid_from=&from=&to=&page=&limit=
const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const where = ['e.deleted_at IS NULL', 'e.store_id = ?'];
  const params = [req.user.storeId];
  if (req.query.category) { where.push('e.category_id = ?'); params.push(req.query.category); }
  if (['pending', 'approved', 'rejected'].includes(req.query.status)) { where.push('e.status = ?'); params.push(req.query.status); }
  if (['main', 'petty_cash'].includes(req.query.paid_from)) { where.push('e.paid_from = ?'); params.push(req.query.paid_from); }
  if (req.query.from) { where.push('e.expense_date >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('e.expense_date <= ?'); params.push(req.query.to); }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = db.prepare(`${LIST_SQL} ${whereSql} ORDER BY e.expense_date DESC, e.created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM expenses e ${whereSql}`).get(...params).c;

  res.json(paginatedResponse({ rows, total, page, limit }));
});

// GET /api/expenses/summary?from=&to=  — totals by category, for Dashboard/reporting.
// Only APPROVED expenses are money spent; what is still waiting is reported separately.
const summary = asyncHandler(async (req, res) => {
  const where = ['e.deleted_at IS NULL', 'e.store_id = ?'];
  const params = [req.user.storeId];
  if (req.query.from) { where.push('e.expense_date >= ?'); params.push(req.query.from); }
  if (req.query.to) { where.push('e.expense_date <= ?'); params.push(req.query.to); }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const byCategory = db.prepare(`
    SELECT c.id AS category_id, c.name AS category_name, SUM(e.amount) AS total
    FROM expenses e JOIN expense_categories c ON c.id = e.category_id
    ${whereSql} AND e.status = 'approved'
    GROUP BY c.id, c.name
    ORDER BY total DESC
  `).all(...params);
  const grandTotal = db.prepare(`SELECT COALESCE(SUM(e.amount), 0) t FROM expenses e ${whereSql} AND e.status = 'approved'`).get(...params).t;
  const pending = db.prepare(`SELECT COALESCE(SUM(e.amount), 0) t, COUNT(*) n FROM expenses e ${whereSql} AND e.status = 'pending'`).get(...params);

  res.json({ data: { grand_total: grandTotal, by_category: byCategory, pending_total: pending.t, pending_count: pending.n } });
});

const getById = asyncHandler(async (req, res) => {
  const expense = db.prepare(`${LIST_SQL} WHERE e.id = ? AND e.store_id = ? AND e.deleted_at IS NULL`)
    .get(req.params.id, req.user.storeId);
  if (!expense) throw new ApiError(404, 'Expense not found.');
  res.json({ data: expense });
});

function assertPettyCashCovers({ storeId, amount, excludeExpenseId }) {
  const { available } = floatFigures(storeId, { excludeExpenseId });
  if (amount > available) {
    throw new ApiError(409, `Not enough petty cash: ${(available / 100).toFixed(2)} available, ${(amount / 100).toFixed(2)} requested. Top up the float first.`, null, 'PETTY_CASH_INSUFFICIENT');
  }
}

function notifyApprovers(req, expense) {
  notifications.notify({
    storeId: req.user.storeId, roles: ['admin', 'manager'], userIds: [], type: 'expense_pending',
    title: 'Expense waiting for approval',
    body: `${req.user.name} recorded ${(expense.amount / 100).toFixed(2)}${expense.paid_from === 'petty_cash' ? ' from petty cash' : ''}.`,
    entityType: 'expense', entityId: expense.id, dedupeKey: `expense_pending:${expense.id}`,
  });
}

// POST /api/expenses  { category_id, amount, description, expense_date, receipt_url, paid_from }
const create = asyncHandler(async (req, res) => {
  const { category_id, amount, description, expense_date, receipt_url } = req.body;
  const paidFrom = req.body.paid_from || 'main';

  const category = db.prepare('SELECT id FROM expense_categories WHERE id = ?').get(category_id);
  if (!category) throw new ApiError(400, 'Unknown category_id.');
  if (paidFrom === 'petty_cash') assertPettyCashCovers({ storeId: req.user.storeId, amount });

  const autoApprove = isAdmin(req.user);
  const result = db.prepare(`
    INSERT INTO expenses (store_id, category_id, amount, description, expense_date, recorded_by_staff_id, receipt_url,
                          paid_from, status, reviewed_by_staff_id, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${autoApprove ? "datetime('now')" : 'NULL'})
  `).run(req.user.storeId, category_id, amount, description || null, expense_date, req.user.id, receipt_url || null,
    paidFrom, autoApprove ? 'approved' : 'pending', autoApprove ? req.user.id : null);

  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId: req.user.id, action: 'create', entityType: 'expense', entityId: expense.id, after: expense });
  if (!autoApprove) notifyApprovers(req, expense);
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
  const paidFrom = req.body.paid_from ?? existing.paid_from;

  if (req.body.category_id !== undefined) {
    const category = db.prepare('SELECT id FROM expense_categories WHERE id = ?').get(category_id);
    if (!category) throw new ApiError(400, 'Unknown category_id.');
  }

  // Back to "pending" when the decision no longer applies to what's on the record.
  const needsNewDecision = existing.status === 'rejected' || (existing.status === 'approved' && !isAdmin(req.user));
  const status = needsNewDecision ? 'pending' : existing.status;
  if (paidFrom === 'petty_cash' && status !== 'rejected') {
    assertPettyCashCovers({ storeId: req.user.storeId, amount, excludeExpenseId: existing.id });
  }

  db.prepare(`
    UPDATE expenses SET category_id=?, amount=?, description=?, expense_date=?, receipt_url=?, paid_from=?,
      status=?, reviewed_by_staff_id=?, reviewed_at=?, review_note=?, updated_at=datetime('now')
    WHERE id=?
  `).run(category_id, amount, description, expense_date, receipt_url, paidFrom, status,
    needsNewDecision ? null : existing.reviewed_by_staff_id, needsNewDecision ? null : existing.reviewed_at,
    needsNewDecision ? null : existing.review_note, req.params.id);

  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  logStaffAction({ staffId: req.user.id, action: 'update', entityType: 'expense', entityId: expense.id, before: existing, after: expense });
  if (needsNewDecision) notifyApprovers(req, expense);
  res.json({ data: expense });
});

function loadPendingForDecision(req) {
  const expense = db.prepare('SELECT * FROM expenses WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.user.storeId);
  if (!expense) throw new ApiError(404, 'Expense not found.');
  if (expense.status !== 'pending') throw new ApiError(409, `This expense is already ${expense.status}.`);
  if (expense.recorded_by_staff_id === req.user.id && !isAdmin(req.user)) {
    throw new ApiError(403, 'You recorded this expense, so someone else has to approve it.');
  }
  return expense;
}

// POST /api/expenses/:id/approve
const approve = asyncHandler(async (req, res) => {
  const existing = loadPendingForDecision(req);
  if (existing.paid_from === 'petty_cash') {
    // already reserved while pending, so only the settled balance matters now
    const { balance } = floatFigures(req.user.storeId, { excludeExpenseId: existing.id });
    if (existing.amount > balance) {
      throw new ApiError(409, 'The petty cash float does not hold enough yet. Approve the pending top-up first.', null, 'PETTY_CASH_INSUFFICIENT');
    }
  }
  db.prepare(`UPDATE expenses SET status='approved', reviewed_by_staff_id=?, reviewed_at=datetime('now'), review_note=NULL, updated_at=datetime('now') WHERE id=?`)
    .run(req.user.id, existing.id);
  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: req.user.id, action: 'update', entityType: 'expense', entityId: expense.id, before: existing, after: expense });
  notifications.notify({
    storeId: req.user.storeId, userIds: [existing.recorded_by_staff_id], type: 'expense_approved',
    title: 'Expense approved', body: `Your expense of ${(existing.amount / 100).toFixed(2)} was approved.`, entityType: 'expense', entityId: expense.id,
  });
  res.json({ data: expense });
});

// POST /api/expenses/:id/reject  { note }
const reject = asyncHandler(async (req, res) => {
  const existing = loadPendingForDecision(req);
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
  if (!note) throw new ApiError(400, 'Say why you are rejecting it (note is required).');
  db.prepare(`UPDATE expenses SET status='rejected', reviewed_by_staff_id=?, reviewed_at=datetime('now'), review_note=?, updated_at=datetime('now') WHERE id=?`)
    .run(req.user.id, note, existing.id);
  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: req.user.id, action: 'update', entityType: 'expense', entityId: expense.id, before: existing, after: expense });
  notifications.notify({
    storeId: req.user.storeId, userIds: [existing.recorded_by_staff_id], type: 'expense_rejected', severity: 'warning',
    title: 'Expense rejected', body: note, entityType: 'expense', entityId: expense.id,
  });
  res.json({ data: expense });
});

// DELETE /api/expenses/:id — soft delete. An approved expense is part of the books, so only an admin can remove it.
const remove = asyncHandler(async (req, res) => {
  const existing = db.prepare('SELECT * FROM expenses WHERE id = ? AND store_id = ? AND deleted_at IS NULL')
    .get(req.params.id, req.user.storeId);
  if (!existing) throw new ApiError(404, 'Expense not found.');
  if (existing.status === 'approved' && !isAdmin(req.user)) {
    throw new ApiError(403, 'An approved expense can only be removed by an admin.', null, 'FORBIDDEN');
  }

  db.prepare(`UPDATE expenses SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
  logStaffAction({ staffId: req.user.id, action: 'delete', entityType: 'expense', entityId: existing.id, before: existing });
  res.status(204).send();
});

module.exports = { list, summary, getById, create, update, approve, reject, remove, listCategories, createCategory };
