const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const notifications = require('./notifications.service');

// The petty-cash float for one store.
//   balance   = approved top-ups  -  approved petty-cash expenses
//   available = balance           -  petty-cash expenses still waiting for approval
// "Available" is what a new spend is checked against, so two spends submitted before either is approved can't
// together promise more money than the drawer holds. Rejected and deleted expenses don't count either way.
function floatFigures(storeId, { excludeExpenseId = null } = {}) {
  const topups = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS t FROM petty_cash_topups WHERE store_id = ? AND status = 'approved'`).get(storeId).t;
  const pendingTopups = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS t, COUNT(*) AS n FROM petty_cash_topups WHERE store_id = ? AND status = 'pending'`).get(storeId);
  const spent = (status) => db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS t, COUNT(*) AS n FROM expenses
    WHERE store_id = ? AND paid_from = 'petty_cash' AND status = ? AND deleted_at IS NULL AND id != ?
  `).get(storeId, status, excludeExpenseId ?? -1);
  const approvedSpend = spent('approved');
  const pendingSpend = spent('pending');
  const balance = topups - approvedSpend.t;
  return {
    topped_up: topups,
    spent: approvedSpend.t,
    balance,
    pending_spend: pendingSpend.t,
    pending_spend_count: pendingSpend.n,
    pending_topups: pendingTopups.t,
    pending_topup_count: pendingTopups.n,
    available: balance - pendingSpend.t,
  };
}

// Same rules as expenses: an admin's top-up is approved at once, anyone else's waits for a different person with
// 'expenses.approve', and nobody approves their own.
const isAdmin = (user) => user.role === 'admin';

// GET /api/petty-cash — the float's figures plus the latest top-ups and petty-cash spends.
function pettyCashOverview({ user }) {
  const storeId = user.storeId;
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
  return { data: { ...floatFigures(storeId), topups, spends } };
}

// POST /api/petty-cash/topups  { amount, note, topup_date }
function createTopup({ body, user }) {
  const { amount, note } = body;
  const date = body.topup_date || new Date().toISOString().slice(0, 10);
  const autoApprove = isAdmin(user);

  const result = db.prepare(`
    INSERT INTO petty_cash_topups (store_id, amount, note, topup_date, recorded_by_staff_id, status, reviewed_by_staff_id, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ${autoApprove ? "datetime('now')" : 'NULL'})
  `).run(user.storeId, amount, note || null, date, user.id, autoApprove ? 'approved' : 'pending', autoApprove ? user.id : null);

  const topup = db.prepare('SELECT * FROM petty_cash_topups WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId: user.id, action: 'create', entityType: 'petty_cash_topup', entityId: topup.id, after: topup });
  if (!autoApprove) {
    notifications.notify({
      storeId: user.storeId, roles: ['admin', 'manager'], type: 'petty_cash_topup_pending',
      title: 'Petty cash top-up waiting for approval',
      body: `${user.name} recorded a top-up of ${(amount / 100).toFixed(2)}.`,
      entityType: 'petty_cash_topup', entityId: topup.id, dedupeKey: `petty_cash_topup_pending:${topup.id}`,
    });
  }
  return { data: topup };
}

function loadPending({ params, user }) {
  const topup = db.prepare('SELECT * FROM petty_cash_topups WHERE id = ? AND store_id = ?').get(params.id, user.storeId);
  if (!topup) throw new ApiError(404, 'Top-up not found.');
  if (topup.status !== 'pending') throw new ApiError(409, `This top-up is already ${topup.status}.`);
  if (topup.recorded_by_staff_id === user.id && !isAdmin(user)) {
    throw new ApiError(403, 'You recorded this top-up, so someone else has to approve it.');
  }
  return topup;
}

function approveTopup({ params, user }) {
  const existing = loadPending({ params: params, user: user });
  db.prepare(`UPDATE petty_cash_topups SET status='approved', reviewed_by_staff_id=?, reviewed_at=datetime('now'), review_note=NULL WHERE id=?`).run(user.id, existing.id);
  const topup = db.prepare('SELECT * FROM petty_cash_topups WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'petty_cash_topup', entityId: topup.id, before: existing, after: topup });
  return { data: topup };
}

function rejectTopup({ params, user, body }) {
  const existing = loadPending({ params: params, user: user });
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!note) throw new ApiError(400, 'Say why you are rejecting it (note is required).');
  db.prepare(`UPDATE petty_cash_topups SET status='rejected', reviewed_by_staff_id=?, reviewed_at=datetime('now'), review_note=? WHERE id=?`).run(user.id, note, existing.id);
  const topup = db.prepare('SELECT * FROM petty_cash_topups WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'petty_cash_topup', entityId: topup.id, before: existing, after: topup });
  return { data: topup };
}

module.exports = { floatFigures, pettyCashOverview, createTopup, approveTopup, rejectTopup };
