const db = require('../config/db');

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

module.exports = { floatFigures };
