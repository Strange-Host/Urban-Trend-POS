const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const notifications = require('./notifications.service');
const { floatFigures } = require('./pettyCash.service');

// Approving / rejecting a pending expense. Moved out of the expenses controller so the website and the mobile app run the
// very same rules: nobody approves their own entry (an admin may), petty-cash expenses need the float to cover them.

const isAdmin = (user) => user.role === 'admin';

function loadPendingForDecision(id, user) {
  const expense = db.prepare('SELECT * FROM expenses WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(id, user.storeId);
  if (!expense) throw new ApiError(404, 'Expense not found.');
  if (expense.status !== 'pending') throw new ApiError(409, `This expense is already ${expense.status}.`);
  if (expense.recorded_by_staff_id === user.id && !isAdmin(user)) {
    throw new ApiError(403, 'You recorded this expense, so someone else has to approve it.');
  }
  return expense;
}

function approve({ id, user }) {
  const existing = loadPendingForDecision(id, user);
  if (existing.paid_from === 'petty_cash') {
    // already reserved while pending, so only the settled balance matters now
    const { balance } = floatFigures(user.storeId, { excludeExpenseId: existing.id });
    if (existing.amount > balance) {
      throw new ApiError(409, 'The petty cash float does not hold enough yet. Approve the pending top-up first.', null, 'PETTY_CASH_INSUFFICIENT');
    }
  }
  db.prepare(`UPDATE expenses SET status='approved', reviewed_by_staff_id=?, reviewed_at=datetime('now'), review_note=NULL, updated_at=datetime('now') WHERE id=?`)
    .run(user.id, existing.id);
  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'expense', entityId: expense.id, before: existing, after: expense });
  notifications.notify({
    storeId: user.storeId, userIds: [existing.recorded_by_staff_id], type: 'expense_approved',
    title: 'Expense approved', body: `Your expense of ${(existing.amount / 100).toFixed(2)} was approved.`, entityType: 'expense', entityId: expense.id,
  });
  return expense;
}

function reject({ id, user, note }) {
  const existing = loadPendingForDecision(id, user);
  const why = typeof note === 'string' ? note.trim() : '';
  if (!why) throw new ApiError(400, 'Say why you are rejecting it (note is required).');
  db.prepare(`UPDATE expenses SET status='rejected', reviewed_by_staff_id=?, reviewed_at=datetime('now'), review_note=?, updated_at=datetime('now') WHERE id=?`)
    .run(user.id, why, existing.id);
  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(existing.id);
  logStaffAction({ staffId: user.id, action: 'update', entityType: 'expense', entityId: expense.id, before: existing, after: expense });
  notifications.notify({
    storeId: user.storeId, userIds: [existing.recorded_by_staff_id], type: 'expense_rejected', severity: 'warning',
    title: 'Expense rejected', body: why, entityType: 'expense', entityId: expense.id,
  });
  return expense;
}

module.exports = { approve, reject };
