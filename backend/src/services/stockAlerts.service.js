const db = require('../config/db');
const costing = require('./costing.service');
const settings = require('./settings.service');
const { shopToday } = require('./stock.service');
const { localDate } = require('../utils/storeTime');

// The stock alerts in one place: low stock, expiring and expired batches, recalled batches and damaged stock. The Stock
// screen, the dashboard and the notification sweep all read from here so they cannot disagree.

function expiryWindowDays() {
  const n = Number(settings.getAll().expiry_alert_days);
  return Number.isInteger(n) && n >= 0 ? n : 30;
}

function damagedSince(days) {
  return localDate(days);
}

// canSeeCost adds the money value of damaged stock; people who may not see buying prices get quantities only.
function summary({ storeId, canSeeCost = false, listLimit = 50 }) {
  const today = shopToday();
  const withinDays = expiryWindowDays();
  const all = costing.batchesByStatus({ storeId, status: 'all', today, withinDays });
  const pick = (state) => all.filter((r) => r.state === state);
  const expired = pick('expired');
  const expiring = pick('expiring');
  const recalled = pick('recalled');

  const lowStock = db.prepare(`
    SELECT COUNT(*) AS c FROM inventory i JOIN products p ON p.id = i.product_id
    WHERE i.store_id = ? AND i.quantity <= i.reorder_level AND p.is_active = 1
  `).get(storeId).c;

  const since = damagedSince(30);
  const damagedIssues = db.prepare(`
    SELECT id, product_id, quantity FROM stock_issues WHERE store_id = ? AND reason = 'damaged' AND issued_on >= ?
  `).all(storeId, since);
  const damagedReturns = db.prepare(`
    SELECT COUNT(*) AS c FROM orders WHERE store_id = ? AND status = 'returned_damaged' AND owner_decision IS NULL AND deleted_at IS NULL
  `).get(storeId).c;
  const damaged = {
    since,
    issues: damagedIssues.length,
    units: damagedIssues.reduce((n, i) => n + i.quantity, 0),
    returns_awaiting_decision: damagedReturns,
  };
  if (canSeeCost) {
    const costs = costing.costOfIssues(damagedIssues);
    damaged.value = [...costs.values()].reduce((n, c) => n + c, 0);
  }

  return {
    today,
    expiry_alert_days: withinDays,
    counts: {
      low_stock: lowStock,
      expired: expired.length,
      expiring: expiring.length,
      recalled: recalled.length,
      damaged_units_30d: damaged.units,
      damaged_returns_awaiting_decision: damagedReturns,
    },
    expired: expired.slice(0, listLimit),
    expiring: expiring.slice(0, listLimit),
    recalled: recalled.slice(0, listLimit),
    damaged,
  };
}

// Counts only - cheap enough for the dashboard.
function counts(storeId) {
  const s = summary({ storeId, canSeeCost: false, listLimit: 0 });
  return s.counts;
}

module.exports = { expiryWindowDays, summary, counts };
