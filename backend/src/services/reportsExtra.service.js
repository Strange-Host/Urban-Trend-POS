const db = require('../config/db');
const payrollService = require('./payroll.service');
const settingsService = require('./settings.service');
const { dateOf } = require('../utils/storeTime');

// The Priority 5 reports that sit beside the P&L: discounts, VAT, and sales-agent performance.
// Read-only, integer cents, scoped to one store.

const DISPATCHED = `('dispatched_unpaid','dispatched_partial','dispatched_paid')`;
const PAID_ONLINE = `('dispatched_paid','dispatched_partial')`;
const ONLINE_SHARE = '(MIN(o.amount_paid, o.total) * 1.0 / o.total)';
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

// --- Discounts ------------------------------------------------------------------------------

// Every till sale and dispatched online order in the range with what was given off it. `list_value`
// is what the goods were worth before any discount, so discount_percent is a true share of list price.
function discountRows({ storeId, from, to }) {
  const sales = db.prepare(`
    SELECT s.id, s.created_at, ${dateOf('s.created_at')} AS date, s.cashier_id AS staff_id, u.name AS staff, s.source_type AS channel,
           s.discount_total + COALESCE(l.line_discount, 0) AS discount,
           s.subtotal + COALESCE(l.line_discount, 0) AS list_value
    FROM sales s
    LEFT JOIN users u ON u.id = s.cashier_id
    LEFT JOIN (SELECT sale_id, SUM(discount) AS line_discount FROM sale_items GROUP BY sale_id) l ON l.sale_id = s.id
    WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ?
  `).all(storeId, from, to).map((r) => ({ ...r, kind: 'sale', reference: `S-${r.id}` }));

  const orders = db.prepare(`
    SELECT o.id, o.dispatched_at AS created_at, ${dateOf('o.dispatched_at')} AS date, o.assigned_staff_id AS staff_id, u.name AS staff, o.channel,
           COALESCE(o.product_code, '#' || o.id) AS reference,
           o.discount_total + COALESCE(l.line_discount, 0) AS discount,
           o.subtotal + COALESCE(l.line_discount, 0) AS list_value
    FROM orders o
    LEFT JOIN users u ON u.id = o.assigned_staff_id
    LEFT JOIN (SELECT order_id, SUM(discount) AS line_discount FROM order_items GROUP BY order_id) l ON l.order_id = o.id
    WHERE o.store_id = ? AND o.status IN ${DISPATCHED} AND o.deleted_at IS NULL AND o.sale_id IS NULL
      AND ${dateOf('o.dispatched_at')} BETWEEN ? AND ?
  `).all(storeId, from, to).map((r) => ({ ...r, kind: 'order' }));

  return [...sales, ...orders];
}

function discountReport({ storeId, from, to }) {
  const rows = discountRows({ storeId, from, to });

  const discounted = rows.filter((r) => r.discount > 0);
  const listValue = rows.reduce((t, r) => t + r.list_value, 0);
  const discountTotal = rows.reduce((t, r) => t + r.discount, 0);

  const group = (keyFn, labelFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      const g = m.get(k) || { key: k, label: labelFn(r), transactions: 0, discounted_transactions: 0, list_value: 0, discount: 0 };
      g.transactions += 1; g.list_value += r.list_value; g.discount += r.discount;
      if (r.discount > 0) g.discounted_transactions += 1;
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, discount_percent: pct(g.discount, g.list_value) }));
  };

  return {
    period: { from, to },
    summary: {
      transactions: rows.length, discounted_transactions: discounted.length,
      list_value: listValue, discount_total: discountTotal, discount_percent: pct(discountTotal, listValue),
    },
    by_staff: group((r) => r.staff_id ?? 0, (r) => r.staff || 'Unassigned').sort((a, b) => b.discount - a.discount)
      .map((g) => ({ staff: g.label, transactions: g.transactions, discounted_transactions: g.discounted_transactions, list_value: g.list_value, discount: g.discount, discount_percent: g.discount_percent })),
    by_day: group((r) => r.date, (r) => r.date).sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((g) => ({ date: g.key, transactions: g.transactions, discounted_transactions: g.discounted_transactions, list_value: g.list_value, discount: g.discount, discount_percent: g.discount_percent })),
    largest: discounted.sort((a, b) => b.discount - a.discount).slice(0, 25)
      .map((r) => ({ date: r.date, kind: r.kind, reference: r.reference, staff: r.staff || 'Unassigned', channel: r.channel, list_value: r.list_value, discount: r.discount, discount_percent: pct(r.discount, r.list_value) })),
  };
}

// --- VAT ------------------------------------------------------------------------------------

// Revenue per shop day, defined exactly as profitLoss() defines revenue (collected goods value,
// net of discounts), so the VAT base always agrees with the P&L.
function revenueByDay({ storeId, from, to }) {
  const days = new Map();
  const add = (d, v) => days.set(d, (days.get(d) || 0) + v);
  for (const r of db.prepare(`
    SELECT ${dateOf('s.created_at')} AS d, COALESCE(SUM(si.line_total), 0) AS revenue
    FROM sale_items si JOIN sales s ON s.id = si.sale_id
    WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ? GROUP BY d
  `).all(storeId, from, to)) add(r.d, r.revenue);
  for (const r of db.prepare(`
    SELECT ${dateOf('s.created_at')} AS d, COALESCE(SUM(discount_total), 0) AS total
    FROM sales s WHERE s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ? GROUP BY d
  `).all(storeId, from, to)) add(r.d, -r.total);
  for (const r of db.prepare(`
    SELECT ${dateOf('o.dispatched_at')} AS d, COALESCE(SUM(CAST(ROUND(oi.line_total * ${ONLINE_SHARE}) AS INTEGER)), 0) AS revenue
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.store_id = ? AND o.status IN ${PAID_ONLINE} AND o.total > 0 AND ${dateOf('o.dispatched_at')} BETWEEN ? AND ?
      AND o.deleted_at IS NULL AND o.sale_id IS NULL GROUP BY d
  `).all(storeId, from, to)) add(r.d, r.revenue);
  return days;
}

// Prices are VAT-inclusive and local checkout adds no tax (see CHANGES.md), so the system holds no
// VAT figure. This ESTIMATES the VAT inside what was sold: vat = gross x rate / (100 + rate), at
// the rate in Settings. It is a working figure to reconcile against the return, not a tax record.
function vatReport({ storeId, from, to }) {
  const rate = parseFloat(settingsService.getAll().vat_rate_percent);
  const ratePercent = Number.isFinite(rate) && rate >= 0 ? rate : 16;
  const split = (gross) => {
    const vat = Math.round((gross * ratePercent) / (100 + ratePercent));
    return { gross, vat, net: gross - vat };
  };
  const byDay = revenueByDay({ storeId, from, to });
  const daily = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, gross]) => ({ date, ...split(gross) }));

  const monthly = new Map();
  for (const [date, gross] of byDay) monthly.set(date.slice(0, 7), (monthly.get(date.slice(0, 7)) || 0) + gross);
  const months = [...monthly.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, gross]) => ({ month, ...split(gross) }));

  const grossTotal = [...byDay.values()].reduce((t, v) => t + v, 0);
  return {
    period: { from, to }, vat_rate_percent: ratePercent, estimated: true,
    note: 'Estimate: prices are treated as VAT-inclusive at this rate. The POS does not record VAT on sales.',
    total: split(grossTotal), months, daily,
  };
}

// --- Sales-agent performance ----------------------------------------------------------------

function agentPerformance({ storeId, from, to }) {
  const staff = db.prepare(`SELECT id, name, role FROM users WHERE store_id = ? AND role IN ('cashier','manager','admin') AND erased_at IS NULL ORDER BY name`).all(storeId);
  const discounts = discountRows({ storeId, from, to });

  const leads = db.prepare(`
    SELECT assigned_staff_id AS id, COUNT(*) AS assigned,
           SUM(status = 'converted') AS converted, SUM(status = 'cancelled') AS lost
    FROM leads WHERE store_id = ? AND deleted_at IS NULL AND assigned_staff_id IS NOT NULL AND ${dateOf('created_at')} BETWEEN ? AND ?
    GROUP BY assigned_staff_id
  `).all(storeId, from, to);
  const ordersCreated = db.prepare(`
    SELECT assigned_staff_id AS id, COUNT(*) AS n FROM orders
    WHERE store_id = ? AND deleted_at IS NULL AND assigned_staff_id IS NOT NULL AND ${dateOf('created_at')} BETWEEN ? AND ? GROUP BY assigned_staff_id
  `).all(storeId, from, to);
  const online = db.prepare(`
    SELECT o.assigned_staff_id AS id, COUNT(DISTINCT o.id) AS orders,
           COALESCE(SUM(CAST(ROUND(oi.line_total * ${ONLINE_SHARE}) AS INTEGER)), 0) AS revenue,
           COALESCE(SUM(CAST(ROUND(oi.quantity * p.cost_price * ${ONLINE_SHARE}) AS INTEGER)), 0) AS cost
    FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id
    WHERE o.store_id = ? AND o.status IN ${PAID_ONLINE} AND o.total > 0 AND o.deleted_at IS NULL AND o.assigned_staff_id IS NOT NULL
      AND ${dateOf('o.dispatched_at')} BETWEEN ? AND ? GROUP BY o.assigned_staff_id
  `).all(storeId, from, to);
  const till = db.prepare(`
    SELECT cashier_id AS id, COUNT(*) AS sales, COALESCE(SUM(total), 0) AS revenue FROM sales
    WHERE store_id = ? AND status = 'completed' AND ${dateOf('created_at')} BETWEEN ? AND ? GROUP BY cashier_id
  `).all(storeId, from, to);

  const by = (rows) => new Map(rows.map((r) => [r.id, r]));
  const L = by(leads); const OC = by(ordersCreated); const ON = by(online); const T = by(till);

  const rows = staff.map((s) => {
    const l = L.get(s.id) || { assigned: 0, converted: 0, lost: 0 };
    const o = ON.get(s.id) || { orders: 0, revenue: 0, cost: 0 };
    const t = T.get(s.id) || { sales: 0, revenue: 0 };
    const given = discounts.filter((d) => d.staff_id === s.id).reduce((n, d) => n + d.discount, 0);
    let commission = 0;
    if (s.role === 'cashier') {
      commission = payrollService.getSummary({ staffId: s.id, storeId, periodStart: from, periodEnd: to }).commission.commissionTotal;
    }
    return {
      staff_id: s.id, staff: s.name, role: s.role,
      leads_assigned: l.assigned, leads_converted: l.converted, leads_lost: l.lost, lead_conversion_percent: pct(l.converted, l.assigned),
      orders_created: OC.get(s.id)?.n || 0,
      orders_collected: o.orders, online_revenue: o.revenue, online_margin: o.revenue - o.cost,
      avg_order_value: o.orders ? Math.round(o.revenue / o.orders) : 0,
      till_sales: t.sales, till_revenue: t.revenue,
      total_revenue: o.revenue + t.revenue,
      discounts_given: given, commission,
    };
  }).filter((r) => r.leads_assigned || r.orders_created || r.orders_collected || r.till_sales || r.discounts_given);

  rows.sort((a, b) => b.total_revenue - a.total_revenue);
  rows.forEach((r, i) => { r.rank = i + 1; });
  const total = rows.reduce((t, r) => ({
    leads_assigned: t.leads_assigned + r.leads_assigned, leads_converted: t.leads_converted + r.leads_converted, leads_lost: t.leads_lost + r.leads_lost,
    orders_created: t.orders_created + r.orders_created, orders_collected: t.orders_collected + r.orders_collected, till_sales: t.till_sales + r.till_sales,
    online_revenue: t.online_revenue + r.online_revenue, till_revenue: t.till_revenue + r.till_revenue, total_revenue: t.total_revenue + r.total_revenue,
    discounts_given: t.discounts_given + r.discounts_given, commission: t.commission + r.commission,
  }), { leads_assigned: 0, leads_converted: 0, leads_lost: 0, orders_created: 0, orders_collected: 0, till_sales: 0, online_revenue: 0, till_revenue: 0, total_revenue: 0, discounts_given: 0, commission: 0 });
  total.lead_conversion_percent = pct(total.leads_converted, total.leads_assigned);
  total.avg_order_value = total.orders_collected ? Math.round(total.online_revenue / total.orders_collected) : 0;
  return { period: { from, to }, rows, total };
}

module.exports = { discountReport, vatReport, agentPerformance, revenueByDay };
