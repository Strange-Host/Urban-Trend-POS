const db = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');
const payrollService = require('../services/payroll.service');
const { monthSegments } = require('../utils/payCycle');
const { PAGINATION } = require('../config/limits');
const { dateOf, localDate, dateParam } = require('../utils/storeTime');

// GET /api/reports/sales-summary?from=&to=
const salesSummary = asyncHandler(async (req, res) => {
  const from = dateParam(req.query.from, 'from', '1970-01-01');
  const to = dateParam(req.query.to, 'to', '2999-12-31');
  const row = db.prepare(`
    SELECT
      COUNT(*) AS transaction_count,
      COALESCE(SUM(total), 0) AS revenue,
      COALESCE(SUM(tax_total), 0) AS tax_collected,
      COALESCE(AVG(total), 0) AS avg_basket
    FROM sales
    WHERE store_id = ? AND status = 'completed' AND ${dateOf('created_at')} BETWEEN ? AND ?
  `).get(req.user.storeId, from, to);
  res.json({ data: row });
});

// GET /api/reports/top-products?from=&to=&limit=10
const topProducts = asyncHandler(async (req, res) => {
  const from = dateParam(req.query.from, 'from', '1970-01-01');
  const to = dateParam(req.query.to, 'to', '2999-12-31');
  const limit = Math.min(parseInt(req.query.limit) || PAGINATION.REPORTS_DEFAULT_LIMIT, PAGINATION.REPORTS_MAX_LIMIT);
  const rows = db.prepare(`
    SELECT p.id, p.name, p.sku,
           SUM(si.quantity) AS units_sold,
           SUM(si.line_total) AS revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ?
    GROUP BY p.id
    ORDER BY units_sold DESC
    LIMIT ?
  `).all(req.user.storeId, from, to, limit);
  res.json({ data: rows });
});

// GET /api/reports/inventory-value
const inventoryValue = asyncHandler(async (req, res) => {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(i.quantity * p.cost_price), 0) AS total_cost_value,
      COALESCE(SUM(i.quantity * p.sell_price), 0) AS total_retail_value,
      COALESCE(SUM(i.quantity), 0) AS total_units
    FROM inventory i JOIN products p ON p.id = i.product_id
    WHERE i.store_id = ? AND p.is_active = 1
  `).get(req.user.storeId);
  res.json({ data: row });
});

// GET /api/reports/sales-by-channel?from=&to=  — revenue split across the
// register and every connected Shopify/WooCommerce income source, all in one view.
const salesByChannel = asyncHandler(async (req, res) => {
  const from = dateParam(req.query.from, 'from', '1970-01-01');
  const to = dateParam(req.query.to, 'to', '2999-12-31');
  const rows = db.prepare(`
    SELECT
      s.source_type,
      COALESCE(iso.id, 0) AS income_source_id,
      COALESCE(iso.name, CASE s.source_type WHEN 'local' THEN 'Local store (register)' ELSE 'Unknown' END) AS channel_name,
      iso.platform,
      COUNT(*) AS transaction_count,
      COALESCE(SUM(s.total), 0) AS revenue,
      COALESCE(SUM(s.tax_total), 0) AS tax_collected,
      COALESCE(AVG(s.total), 0) AS avg_basket
    FROM sales s
    LEFT JOIN income_sources iso ON iso.id = s.income_source_id
    WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ?
    GROUP BY s.source_type, income_source_id
    ORDER BY revenue DESC
  `).all(req.user.storeId, from, to);
  res.json({ data: rows });
});

// GET /api/reports/sales-trend?from=&to=  — daily revenue series, split by channel type,
// for charting. Buckets by calendar day (YYYY-MM-DD) in local sale timestamps.
const salesTrend = asyncHandler(async (req, res) => {
  const from = dateParam(req.query.from, 'from', isoDaysAgo(29));
  const to = dateParam(req.query.to, 'to', '2999-12-31');
  const rows = db.prepare(`
    SELECT
      ${dateOf('s.created_at')} AS day,
      s.source_type,
      COUNT(*) AS transaction_count,
      COALESCE(SUM(s.total), 0) AS revenue
    FROM sales s
    WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ?
    GROUP BY day, s.source_type
    ORDER BY day ASC
  `).all(req.user.storeId, from, to);
  res.json({ data: rows });
});

// GET /api/reports/payment-methods?from=&to=
const paymentMethods = asyncHandler(async (req, res) => {
  const from = dateParam(req.query.from, 'from', '1970-01-01');
  const to = dateParam(req.query.to, 'to', '2999-12-31');
  const rows = db.prepare(`
    SELECT
      p.method,
      COUNT(*) AS payment_count,
      COALESCE(SUM(p.amount), 0) AS total_amount
    FROM payments p
    JOIN sales s ON s.id = p.sale_id
    WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ?
    GROUP BY p.method
    ORDER BY total_amount DESC
  `).all(req.user.storeId, from, to);
  res.json({ data: rows });
});

// GET /api/reports/top-products-by-channel?from=&to=&limit=10 — same as
// top-products, but broken out per channel, useful for spotting products
// that sell online vs. in-store.
const topProductsByChannel = asyncHandler(async (req, res) => {
  const from = dateParam(req.query.from, 'from', '1970-01-01');
  const to = dateParam(req.query.to, 'to', '2999-12-31');
  const limit = Math.min(parseInt(req.query.limit) || PAGINATION.TOP_PRODUCTS_BY_CHANNEL_DEFAULT_LIMIT, PAGINATION.TOP_PRODUCTS_BY_CHANNEL_MAX_LIMIT);
  const rows = db.prepare(`
    SELECT p.id, p.name, p.sku, s.source_type,
           SUM(si.quantity) AS units_sold,
           SUM(si.line_total) AS revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ?
    GROUP BY p.id, s.source_type
    ORDER BY s.source_type, revenue DESC
  `).all(req.user.storeId, from, to);

  const byChannel = {};
  for (const row of rows) {
    byChannel[row.source_type] = byChannel[row.source_type] || [];
    if (byChannel[row.source_type].length < limit) byChannel[row.source_type].push(row);
  }
  res.json({ data: byChannel });
});

function isoDaysAgo(days) {
  return localDate(days);
}

// GET /api/reports/dashboard-overview?date=YYYY-MM-DD (defaults to today)
// The "inventory management system" home screen the whole POS conversion
// was for — answers most of the day-to-day questions in one call: combined
// POS+online sales today, cash actually collected today, an order-status
// breakdown (unpaid/partial/returned/cancelled), unpaid parcels grouped by
// courier (with capital tied up), current stock value, and a low-stock
// count (full detail stays at the existing GET /api/inventory/low-stock).
const dashboardOverview = asyncHandler(async (req, res) => {
  const date = dateParam(req.query.date, 'date', isoDaysAgo(0));
  const storeId = req.user.storeId;

  const posSalesToday = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS revenue, COUNT(*) AS transaction_count
    FROM sales WHERE store_id = ? AND status = 'completed' AND ${dateOf('created_at')} = ?
  `).get(storeId, date);

  // "Sold" for an online order means actually collected, not just placed —
  // dispatched_paid (fully) plus the paid portion of dispatched_partial,
  // both dispatched today, is the closest equivalent to a POS sale.
  const onlineSalesToday = db.prepare(`
    SELECT COALESCE(SUM(amount_paid), 0) AS revenue, COUNT(*) AS order_count
    FROM orders
    WHERE store_id = ? AND status IN ('dispatched_paid','dispatched_partial') AND ${dateOf('dispatched_at')} = ? AND deleted_at IS NULL AND sale_id IS NULL
  `).get(storeId, date);

  // Cash actually collected today, across every channel — POS payments
  // table and order payment_records both, since "how much cash should we
  // have received" means money that moved today, not orders created today.
  const posCashToday = db.prepare(`
    SELECT COALESCE(SUM(p.amount), 0) AS total FROM payments p JOIN sales s ON s.id = p.sale_id
    WHERE s.store_id = ? AND ${dateOf('p.created_at')} = ?
  `).get(storeId, date);
  const orderCashToday = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM payment_records
    WHERE store_id = ? AND direction = 'incoming' AND status = 'completed' AND order_id IS NOT NULL AND ${dateOf('created_at')} = ?
      AND order_id NOT IN (SELECT id FROM orders WHERE sale_id IS NOT NULL)
  `).get(storeId, date);

  const orderStatusBreakdown = db.prepare(`
    SELECT status, COUNT(*) AS count, COALESCE(SUM(total - amount_paid), 0) AS outstanding_value
    FROM orders WHERE store_id = ? AND deleted_at IS NULL GROUP BY status
  `).all(storeId);

  const unpaidParcelsByCourier = db.prepare(`
    SELECT COALESCE(courier_type, 'unassigned') AS courier_type, COUNT(*) AS parcel_count,
           COALESCE(SUM(total - amount_paid), 0) AS capital_tied_up
    FROM orders
    WHERE store_id = ? AND status IN ('dispatched_unpaid','dispatched_partial') AND deleted_at IS NULL
    GROUP BY courier_type
  `).all(storeId);

  const stockValue = db.prepare(`
    SELECT COALESCE(SUM(i.quantity * p.cost_price), 0) AS total_cost_value,
           COALESCE(SUM(i.quantity), 0) AS total_units
    FROM inventory i JOIN products p ON p.id = i.product_id
    WHERE i.store_id = ? AND p.is_active = 1
  `).get(storeId);

  const lowStockCount = db.prepare(`
    SELECT COUNT(*) AS c FROM inventory i JOIN products p ON p.id = i.product_id
    WHERE i.store_id = ? AND i.quantity <= i.reorder_level AND p.is_active = 1
  `).get(storeId).c;

  res.json({
    data: {
      date,
      salesToday: {
        posRevenue: posSalesToday.revenue,
        onlineRevenue: onlineSalesToday.revenue,
        combinedRevenue: posSalesToday.revenue + onlineSalesToday.revenue,
        posTransactionCount: posSalesToday.transaction_count,
        onlineOrderCount: onlineSalesToday.order_count,
      },
      cashCollectedToday: posCashToday.total + orderCashToday.total,
      orderStatusBreakdown,
      unpaidParcelsByCourier,
      stockOnHand: stockValue,
      lowStockCount, // full detail: GET /api/inventory/low-stock
    },
  });
});

// GET /api/reports/unpaid-parcels?courier=boda|g4s — the row-level detail
// behind dashboard-overview's unpaidParcelsByCourier grouping.
const unpaidParcels = asyncHandler(async (req, res) => {
  const where = ["o.store_id = ?", "o.status IN ('dispatched_unpaid','dispatched_partial')", "o.deleted_at IS NULL"];
  const params = [req.user.storeId];
  if (req.query.courier) { where.push('o.courier_type = ?'); params.push(req.query.courier); }

  const rows = db.prepare(`
    SELECT o.id, o.courier_type, o.total, o.amount_paid, (o.total - o.amount_paid) AS outstanding,
           o.dispatched_at, o.product_code, c.name AS customer_name, c.phone AS customer_phone
    FROM orders o JOIN customers c ON c.id = o.customer_id
    WHERE ${where.join(' AND ')}
    ORDER BY o.dispatched_at ASC
  `).all(...params);
  res.json({ data: rows });
});

// GET /api/reports/profit-summary?from=&to=
// "What is the actual profit, after product cost, delivery, advertising,
// salaries and other expenses?" — the one report the whole requirements
// doc kept circling back to. Combines POS sales + collected online orders
// for revenue, product cost for both, delivery fees the shop actually
// pays couriers, telesales payroll (retainer+commission — see
// payroll.service.js; this is gross labor cost, not net-of-deductions,
// since deductions reduce what a STAFF member takes home, not what the
// business spent), and the existing Owner/Admin `expenses` table
// (marketing, ads, misc). Admin/manager salaries aren't tracked anywhere
// in this app (only telesales retainer+commission is), so they're not in
// this number — a real "total salaries" figure needs that added first.
const profitSummary = asyncHandler(async (req, res) => {
  const storeId = req.user.storeId;
  const from = dateParam(req.query.from, 'from', isoDaysAgo(29));
  const to = dateParam(req.query.to, 'to', isoDaysAgo(0));

  // POS: line totals are already net of per-line discounts, but a sale can also carry a
  // sale-level discount (sales.discount_total) that never reaches the lines. Revenue is what the
  // customer actually paid for goods, so take that discount off too.
  const posRevenueCost = db.prepare(`
    SELECT COALESCE(SUM(si.line_total), 0) AS revenue, COALESCE(SUM(si.quantity * p.cost_price), 0) AS cost
    FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
    WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ?
  `).get(storeId, from, to);
  const posSaleDiscounts = db.prepare(`
    SELECT COALESCE(SUM(discount_total), 0) AS total FROM sales s
    WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ?
  `).get(storeId, from, to).total;
  posRevenueCost.revenue -= posSaleDiscounts;

  // Online: count only the collected share of an order. A part-paid order (dispatched_partial)
  // used to count its FULL value as revenue; now both revenue and the cost of the goods are
  // scaled by amount_paid / total (capped at 1), matching the dashboard's "sold = collected".
  const onlineRevenueCost = db.prepare(`
    SELECT
      COALESCE(SUM(CAST(ROUND(oi.line_total * MIN(o.amount_paid, o.total) * 1.0 / o.total) AS INTEGER)), 0) AS revenue,
      COALESCE(SUM(CAST(ROUND(oi.quantity * p.cost_price * MIN(o.amount_paid, o.total) * 1.0 / o.total) AS INTEGER)), 0) AS cost
    FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
    WHERE o.store_id = ? AND o.status IN ('dispatched_paid','dispatched_partial') AND o.total > 0
      AND ${dateOf('o.dispatched_at')} BETWEEN ? AND ? AND o.deleted_at IS NULL AND o.sale_id IS NULL
  `).get(storeId, from, to);

  const deliveryFees = db.prepare(`
    SELECT COALESCE(SUM(delivery_fee), 0) AS total FROM orders
    WHERE store_id = ? AND status IN ('dispatched_unpaid','dispatched_partial','dispatched_paid') AND ${dateOf('dispatched_at')} BETWEEN ? AND ? AND deleted_at IS NULL
  `).get(storeId, from, to).total;

  const businessExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM expenses
    WHERE store_id = ? AND expense_date BETWEEN ? AND ? AND deleted_at IS NULL AND status = 'approved'
  `).get(storeId, from, to).total;

  const telesalesStaff = db.prepare(`SELECT id FROM users WHERE store_id = ? AND role = 'cashier' AND is_active = 1`).all(storeId);
  let laborCost = 0;
  for (const staff of telesalesStaff) {
    // Commission targets reset each month, so a range that spans months is costed month by month and added up.
    for (const seg of monthSegments(from, to)) {
      const summary = payrollService.getSummary({ staffId: staff.id, storeId, periodStart: seg.from, periodEnd: seg.to });
      laborCost += summary.dailyRetainer.total + summary.commission.commissionTotal;
    }
  }

  const revenue = posRevenueCost.revenue + onlineRevenueCost.revenue;
  const costOfGoodsSold = posRevenueCost.cost + onlineRevenueCost.cost;
  const netProfit = revenue - costOfGoodsSold - deliveryFees - laborCost - businessExpenses;

  res.json({
    data: {
      period: { from, to },
      revenue, costOfGoodsSold, deliveryFees, laborCost, businessExpenses,
      grossMargin: revenue - costOfGoodsSold,
      netProfit,
    },
  });
});

// GET /api/reports/top-products-by-profit?from=&to=&limit=10 — combines
// POS + online sales, unlike the original top-products (POS only).
const topProductsByProfit = asyncHandler(async (req, res) => {
  const storeId = req.user.storeId;
  const from = dateParam(req.query.from, 'from', isoDaysAgo(29));
  const to = dateParam(req.query.to, 'to', isoDaysAgo(0));
  const limit = Math.min(parseInt(req.query.limit) || PAGINATION.REPORTS_DEFAULT_LIMIT, PAGINATION.REPORTS_MAX_LIMIT);

  const rows = db.prepare(`
    SELECT p.id, p.name, p.sku,
      COALESCE(SUM(units_sold), 0) AS units_sold,
      COALESCE(SUM(revenue), 0) AS revenue,
      COALESCE(SUM(cost), 0) AS cost,
      COALESCE(SUM(revenue), 0) - COALESCE(SUM(cost), 0) AS profit
    FROM (
      SELECT si.product_id, si.quantity AS units_sold, si.line_total AS revenue, si.quantity * p2.cost_price AS cost
      FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p2 ON p2.id = si.product_id
      WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ?
      UNION ALL
      SELECT oi.product_id, oi.quantity, oi.line_total, oi.quantity * p2.cost_price
      FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p2 ON p2.id = oi.product_id
      WHERE o.store_id = ? AND o.status IN ('dispatched_paid','dispatched_partial') AND ${dateOf('o.dispatched_at')} BETWEEN ? AND ? AND o.deleted_at IS NULL AND o.sale_id IS NULL
    ) combined
    JOIN products p ON p.id = combined.product_id
    GROUP BY p.id
    ORDER BY profit DESC
    LIMIT ?
  `).all(storeId, from, to, storeId, from, to, limit);
  res.json({ data: rows });
});

// GET /api/reports/top-staff-by-profit?from=&to=&limit=10 — telesales reps
// ranked by gross margin their dispatched-and-paid orders generated (§6:
// "Track sales allocation vs achievement", "side-by-side staff comparison").
// This is margin contribution, not fully-loaded profit after their own
// commission — pair with GET /api/payroll/summary for the commission cost
// of any one rep.
const topStaffByProfit = asyncHandler(async (req, res) => {
  const storeId = req.user.storeId;
  const from = dateParam(req.query.from, 'from', isoDaysAgo(29));
  const to = dateParam(req.query.to, 'to', isoDaysAgo(0));
  const limit = Math.min(parseInt(req.query.limit) || PAGINATION.REPORTS_DEFAULT_LIMIT, PAGINATION.REPORTS_MAX_LIMIT);

  const rows = db.prepare(`
    SELECT u.id AS staff_id, u.name,
      COUNT(DISTINCT o.id) AS orders_count,
      COALESCE(SUM(oi.line_total), 0) AS revenue,
      COALESCE(SUM(oi.quantity * p.cost_price), 0) AS cost,
      COALESCE(SUM(oi.line_total), 0) - COALESCE(SUM(oi.quantity * p.cost_price), 0) AS margin
    FROM orders o
    JOIN users u ON u.id = o.assigned_staff_id
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products p ON p.id = oi.product_id
    WHERE o.store_id = ? AND o.status IN ('dispatched_paid','dispatched_partial') AND ${dateOf('o.dispatched_at')} BETWEEN ? AND ? AND o.deleted_at IS NULL
    GROUP BY u.id
    ORDER BY margin DESC
    LIMIT ?
  `).all(storeId, from, to, limit);
  res.json({ data: rows });
});

module.exports = {
  salesSummary, topProducts, inventoryValue, salesByChannel, salesTrend, paymentMethods, topProductsByChannel,
  dashboardOverview, unpaidParcels, profitSummary, topProductsByProfit, topStaffByProfit,
};
