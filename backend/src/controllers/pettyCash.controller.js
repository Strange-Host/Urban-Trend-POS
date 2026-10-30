const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { logStaffAction } = require('../utils/auditLog');
const notifications = require('../services/notifications.service');
const { floatFigures } = require('../services/pettyCash.service');

// Same rules as expenses: an admin's top-up is approved at once, anyone else's waits for a different person with
// 'expenses.approve', and nobody approves their own.
const isAdmin = (user) => user.role === 'admin';

// GET /api/petty-cash — the float's figures plus the latest top-ups and petty-cash spends.
const overview = asyncHandler(async (req, res) => {
  const storeId = req.user.storeId;
  const topups = db.prepare(`
    SELECT t.*, u.name AS recorded_by_name, r.name AS reviewed_by_name
    FROM petty_cash_topups t
    JOIN users u ON u.id = t.recorded_by_staff_id
    LEFT JOIN users r ON r.id = t.reviewed_by_staff_id
    WHERE t.store_id = ? ORDER BY t.topup_date DESC, t.id DESC LIMIT 30
  `).all(storeId);
  const spends = db.prepare(`
    SELECT e.id, e.amount, e.description, e.expense_date, e.status, c.name AS category_name, u.name AS recorded_by_name
    FROM expenses e JOIN expense_categories c ON c.id = e.category_id JOIN users u ON u.id = e.recorded_by_staff_id
    WHERE e.store_id = ? AND e.paid_from = 'petty_cash' AND e.deleted_at IS NULL
    ORDER BY e.expense_date DESC, e.id DESC LIMIT 30
  `).all(storeId);
  res.json({ data: { ...floatFigures(storeId), topups, spends } });
});

// POST /api/petty-cash/topups  { amount, note, topup_date }
const createTopup = asyncHandler(async (req, res) => {
  const { amount, note } = req.body;
  const date = req.body.topup_date || new Date().toISOString().slice(0, 10);
  const autoApprove = isAdmin(req.user);

  const result = db.prepare(`
    INSERT INTO petty_cash_topups (store_id, amount, note, topup_date, recorded_by_staff_id, status, reviewed_by_staff_id, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ${autoApprove ? "datetime('now')" : 'NULL'})
  `).run(req.user.storeId, amount, note || null, date, req.user.id, autoApprove ? 'approved' : 'pending', autoApprove ? req.user.id : null);

  const topup = db.prepare('SELECT * FROM petty_cash_topups WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId: req.user.id, action: 'create', entityType: 'petty_cash_topup', entityId: topup.id, after: topup });
  if (!autoApprove) {
    notifications.notify({
      storeId: req.user.storeId, roles: ['admin', 'manager'], type: 'petty_cash_topup_pending',
      title: 'Petty cash top-up waiting for approval',
      body: `${req.user.name} recorded a top-up of ${(amount / 100).toFixed(2)}.`,
      entityType: 'petty_cash_topup', entityId: topup.id, dedupeKey: `petty_cash_topup_pending:${topup.id}`,
    });
  }
  res.status(201).json({ data: topup });
});

function loadPending(req) {
  const topup = db.prepare('SELECT * FROM petty_cash_topups WHERE id = ? AND store_id = ?').get(req.params.id, req.user.storeId);
  if (!topup) throw new ApiError(404, 'Top-up not found.');
  if (topup.status !== 'pending') throw new ApiError(409, `This top-up is already ${topup.status}.`);
  if (topup.recorded_by_staff_id === req.user.id && !isAdmin(req.user)) {
    throw new ApiError(403, 'You recorded this top-up, so someone else has to approve it.');
  }
  return topup;
}

const approveTopup = asyncHandler(async (req, res) => {
  const existing = loadPending(req);
  db.prepare(`UPDATE petty_cash_topups SET status='approved', reviewed_by_staff_id=?, reviewed_at=datetime('now'), review_note=NULL WHERE id=?`).run(req.user.id, existing.id);
  const topup = db.prepare('SELECT * FROM petty_cash_topups WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: req.user.id, action: 'update', entityType: 'petty_cash_topup', entityId: topup.id, before: existing, after: topup });
  res.json({ data: topup });
});

const rejectTopup = asyncHandler(async (req, res) => {
  const existing = loadPending(req);
  const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';
  if (!note) throw new ApiError(400, 'Say why you are rejecting it (note is required).');
  db.prepare(`UPDATE petty_cash_topups SET status='rejected', reviewed_by_staff_id=?, reviewed_at=datetime('now'), review_note=? WHERE id=?`).run(req.user.id, note, existing.id);
  const topup = db.prepare('SELECT * FROM petty_cash_topups WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: req.user.id, action: 'update', entityType: 'petty_cash_topup', entityId: topup.id, before: existing, after: topup });
  res.json({ data: topup });
});

module.exports = { overview, createTopup, approveTopup, rejectTopup };
