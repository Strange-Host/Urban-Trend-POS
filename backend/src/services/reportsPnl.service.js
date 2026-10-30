const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const payrollService = require('./payroll.service');
const { monthSegments } = require('../utils/payCycle');
const { dateOf, localDate } = require('../utils/storeTime');

// Profit & loss and its companions: by category, by branch (store), and forecast vs actual.
// Everything here is read-only over the same records the dashboard uses, and all money is
// integer cents. profitLoss() is THE definition of revenue/cost/profit: the other views are
// slices of it and are tested to add back up to it.

const PAID_ONLINE = `('dispatched_paid','dispatched_partial')`;
const DISPATCHED = `('dispatched_unpaid','dispatched_partial','dispatched_paid')`;

// Online revenue/cost count only the collected share of an order (a part-paid order counts
// what was paid), matching the dashboard's "sold = collected".
const ONLINE_SHARE = '(MIN(o.amount_paid, o.total) * 1.0 / o.total)';

function profitLoss({ storeId, from, to }) {
  const pos = db.prepare(`
    SELECT COALESCE(SUM(si.line_total), 0) AS revenue, COALESCE(SUM(si.quantity * p.cost_price), 0) AS cost
    FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
    WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ?
  `).get(storeId, from, to);
  // A sale can carry a sale-level discount that never reaches the lines; revenue is what the customer paid for goods.
  const saleDiscounts = db.prepare(`
    SELECT COALESCE(SUM(discount_total), 0) AS total FROM sales s
    WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ?
  `).get(storeId, from, to).total;

  const online = db.prepare(`
    SELECT
      COALESCE(SUM(CAST(ROUND(oi.line_total * ${ONLINE_SHARE}) AS INTEGER)), 0) AS revenue,
      COALESCE(SUM(CAST(ROUND(oi.quantity * p.cost_price * ${ONLINE_SHARE}) AS INTEGER)), 0) AS cost
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
    WHERE o.store_id = ? AND o.status IN ${PAID_ONLINE} AND o.total > 0
      AND ${dateOf('o.dispatched_at')} BETWEEN ? AND ? AND o.deleted_at IS NULL AND o.sale_id IS NULL
  `).get(storeId, from, to);

  const deliveryFees = db.prepare(`
    SELECT COALESCE(SUM(delivery_fee), 0) AS total FROM orders
    WHERE store_id = ? AND status IN ${DISPATCHED} AND ${dateOf('dispatched_at')} BETWEEN ? AND ? AND deleted_at IS NULL
  `).get(storeId, from, to).total;

  const businessExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
    WHERE store_id = ? AND expense_date BETWEEN ? AND ? AND deleted_at IS NULL AND status = 'approved'
  `).get(storeId, from, to).total;

  let laborCost = 0;
  const telesales = db.prepare(`SELECT id FROM users WHERE store_id = ? AND role = 'cashier' AND is_active = 1`).all(storeId);
  for (const staff of telesales) {
    // Commission targets reset each month, so a range that spans months is costed month by month and added up.
    for (const seg of monthSegments(from, to)) {
      const summary = payrollService.getSummary({ staffId: staff.id, storeId, periodStart: seg.from, periodEnd: seg.to });
      laborCost += summary.dailyRetainer.total + summary.commission.commissionTotal;
    }
  }

  const revenue = pos.revenue - saleDiscounts + online.revenue;
  const costOfGoodsSold = pos.cost + online.cost;
  const grossMargin = revenue - costOfGoodsSold;
  const netProfit = grossMargin - deliveryFees - laborCost - businessExpenses;
  return { period: { from, to }, revenue, costOfGoodsSold, deliveryFees, laborCost, businessExpenses, grossMargin, netProfit };
}

// Revenue/cost/margin per product category, POS + online. The sale-level discount cannot be
// split by category, so it shows as its own row; that keeps the rows adding up to profitLoss().
function byCategory({ storeId, from, to }) {
  const rows = db.prepare(`
    SELECT COALESCE(c.name, 'Uncategorised') AS category, SUM(units) AS units, SUM(revenue) AS revenue, SUM(cost) AS cost
    FROM (
      SELECT p.category_id, si.quantity AS units, si.line_total AS revenue, si.quantity * p.cost_price AS cost
      FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
      WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ?
      UNION ALL
      SELECT p.category_id, oi.quantity,
             CAST(ROUND(oi.line_total * ${ONLINE_SHARE}) AS INTEGER),
             CAST(ROUND(oi.quantity * p.cost_price * ${ONLINE_SHARE}) AS INTEGER)
      FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
      WHERE o.store_id = ? AND o.status IN ${PAID_ONLINE} AND o.total > 0
        AND ${dateOf('o.dispatched_at')} BETWEEN ? AND ? AND o.deleted_at IS NULL AND o.sale_id IS NULL
    ) x
    LEFT JOIN categories c ON c.id = x.category_id
    GROUP BY c.id
    ORDER BY revenue DESC
  `).all(storeId, from, to, storeId, from, to);

  const saleDiscounts = db.prepare(`
    SELECT COALESCE(SUM(discount_total), 0) AS total FROM sales s
    WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ?
  `).get(storeId, from, to).total;

  const out = rows.map((r) => ({ category: r.category, units: r.units, revenue: r.revenue, cost: r.cost, margin: r.revenue - r.cost }));
  if (saleDiscounts) out.push({ category: 'Sale-level discounts (not split by category)', units: 0, revenue: -saleDiscounts, cost: 0, margin: -saleDiscounts });
  const total = out.reduce((t, r) => ({ units: t.units + r.units, revenue: t.revenue + r.revenue, cost: t.cost + r.cost, margin: t.margin + r.margin }), { units: 0, revenue: 0, cost: 0, margin: 0 });
  for (const r of out) r.margin_percent = r.revenue > 0 ? Math.round((r.margin / r.revenue) * 1000) / 10 : null;
  return { rows: out, total };
}

// Which stores the caller may compare: an admin sees every active branch; anyone else only their own.
function branchesFor(user) {
  if (user.role === 'admin') return db.prepare('SELECT id, name FROM stores WHERE is_active = 1 ORDER BY name').all();
  return db.prepare('SELECT id, name FROM stores WHERE id = ?').all(user.storeId);
}

function byBranch({ user, from, to }) {
  const rows = branchesFor(user).map((store) => {
    const pl = profitLoss({ storeId: store.id, from, to });
    const orders = db.prepare(`
      SELECT COUNT(*) AS n FROM orders WHERE store_id = ? AND status IN ${DISPATCHED} AND ${dateOf('dispatched_at')} BETWEEN ? AND ? AND deleted_at IS NULL
    `).get(store.id, from, to).n;
    const sales = db.prepare(`
      SELECT COUNT(*) AS n FROM sales WHERE store_id = ? AND status = 'completed' AND ${dateOf('created_at')} BETWEEN ? AND ?
    `).get(store.id, from, to).n;
    return {
      store_id: store.id, branch: store.name, ...pl,
      transactions: orders + sales,
      margin_percent: pl.revenue > 0 ? Math.round((pl.netProfit / pl.revenue) * 1000) / 10 : null,
    };
  });
  const total = rows.reduce((t, r) => ({
    revenue: t.revenue + r.revenue, costOfGoodsSold: t.costOfGoodsSold + r.costOfGoodsSold, deliveryFees: t.deliveryFees + r.deliveryFees,
    laborCost: t.laborCost + r.laborCost, businessExpenses: t.businessExpenses + r.businessExpenses, netProfit: t.netProfit + r.netProfit, transactions: t.transactions + r.transactions,
  }), { revenue: 0, costOfGoodsSold: 0, deliveryFees: 0, laborCost: 0, businessExpenses: 0, netProfit: 0, transactions: 0 });
  total.margin_percent = total.revenue > 0 ? Math.round((total.netProfit / total.revenue) * 1000) / 10 : null;
  return { rows, total };
}

// --- Forecast vs actual ---------------------------------------------------------------------

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function assertMonth(month) {
  if (!MONTH_RE.test(String(month || ''))) throw new ApiError(400, 'month must be in YYYY-MM format.');
}
function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}`, days: last };
}
function monthsBetween(from, to) {
  const out = []; let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
    if (out.length > 36) break; // a sane ceiling for one report
  }
  return out;
}

function getForecast(storeId, month) {
  return db.prepare('SELECT * FROM sales_forecasts WHERE store_id = ? AND month = ?').get(storeId, month) || null;
}

function listForecasts({ storeId, from, to }) {
  return db.prepare('SELECT * FROM sales_forecasts WHERE store_id = ? AND month BETWEEN ? AND ? ORDER BY month').all(storeId, from.slice(0, 7), to.slice(0, 7));
}

function setForecast({ storeId, staffId, month, revenueTarget, expenseBudget, notes }) {
  assertMonth(month);
  for (const [name, v] of [['revenue_target', revenueTarget], ['expense_budget', expenseBudget]]) {
    if (!Number.isInteger(v) || v < 0) throw new ApiError(400, `${name} must be a whole, non-negative amount in cents.`);
  }
  db.prepare(`
    INSERT INTO sales_forecasts (store_id, month, revenue_target, expense_budget, notes, updated_by)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(store_id, month) DO UPDATE SET revenue_target = excluded.revenue_target, expense_budget = excluded.expense_budget,
      notes = excluded.notes, updated_by = excluded.updated_by, updated_at = datetime('now')
  `).run(storeId, month, revenueTarget, expenseBudget, notes || null, staffId || null);
  return getForecast(storeId, month);
}

// One row per calendar month in the range. Operating expenses = delivery + labour + business
// expenses (everything except the cost of goods), the figure the budget is set against. The
// current month is month-to-date, so it also reports whether revenue is on pace for the target.
function forecastVsActual({ storeId, from, to, today = localDate(0) }) {
  const rows = monthsBetween(from, to).map((month) => {
    const { start, end, days } = monthBounds(month);
    const upTo = end < today ? end : today;
    const forecast = getForecast(storeId, month);
    const base = { month, has_forecast: Boolean(forecast), revenue_target: forecast?.revenue_target ?? null, expense_budget: forecast?.expense_budget ?? null };
    if (start > today) return { ...base, revenue_actual: 0, operating_expenses_actual: 0, net_profit_actual: 0, revenue_variance: null, revenue_attainment_percent: null, expense_variance: null, in_progress: false, days_elapsed: 0, days_in_month: days, on_pace_percent: null };

    const pl = profitLoss({ storeId, from: start, to: upTo });
    const opex = pl.deliveryFees + pl.laborCost + pl.businessExpenses;
    const inProgress = end >= today;
    const elapsed = Number(upTo.slice(8, 10));
    const target = forecast?.revenue_target || 0;
    return {
      ...base,
      revenue_actual: pl.revenue, operating_expenses_actual: opex, net_profit_actual: pl.netProfit,
      revenue_variance: forecast ? pl.revenue - target : null,
      revenue_attainment_percent: target > 0 ? Math.round((pl.revenue / target) * 1000) / 10 : null,
      expense_variance: forecast ? opex - forecast.expense_budget : null,   // positive = over budget
      in_progress: inProgress, days_elapsed: elapsed, days_in_month: days,
      on_pace_percent: inProgress && target > 0 ? Math.round((pl.revenue / (target * (elapsed / days))) * 1000) / 10 : null,
    };
  });
  // Totals cover only months that HAVE a forecast, so target and actual are compared like for like.
  const withForecast = rows.filter((r) => r.has_forecast);
  const sum = (k) => withForecast.reduce((t, r) => t + (r[k] || 0), 0);
  const total = {
    revenue_target: sum('revenue_target'), revenue_actual: sum('revenue_actual'),
    expense_budget: sum('expense_budget'), operating_expenses_actual: sum('operating_expenses_actual'),
    net_profit_actual: sum('net_profit_actual'),
  };
  total.revenue_variance = withForecast.length ? total.revenue_actual - total.revenue_target : null;
  total.revenue_attainment_percent = total.revenue_target > 0 ? Math.round((total.revenue_actual / total.revenue_target) * 1000) / 10 : null;
  total.expense_variance = withForecast.length ? total.operating_expenses_actual - total.expense_budget : null;
  return { rows, total };
}

module.exports = { profitLoss, byCategory, byBranch, branchesFor, forecastVsActual, setForecast, getForecast, listForecasts, monthBounds, monthsBetween };
