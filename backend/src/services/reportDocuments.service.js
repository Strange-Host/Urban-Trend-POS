const ApiError = require('../utils/ApiError');
const settingsService = require('./settings.service');
const pnl = require('./reportsPnl.service');
const extra = require('./reportsExtra.service');

// Builds the printable/exportable form of each report (see utils/reportExport.js for the shape).
// The JSON endpoints and the Excel/PDF exports both come from the same service calls, so a
// downloaded sheet can never disagree with what is on screen.

const T = (key, header) => ({ key, header, type: 'text' });
const I = (key, header) => ({ key, header, type: 'int' });
const M = (key, header) => ({ key, header, type: 'money' });
const P = (key, header) => ({ key, header, type: 'percent' });
const D = (key, header) => ({ key, header, type: 'date' });

function pnlDocument({ user, from, to }) {
  const storeId = user.storeId;
  const s = pnl.profitLoss({ storeId, from, to });
  const cat = pnl.byCategory({ storeId, from, to });
  const branches = pnl.byBranch({ user, from, to });
  const fc = pnl.forecastVsActual({ storeId, from, to });

  return {
    title: 'Profit & Loss',
    sections: [
      {
        heading: 'Summary',
        columns: [T('line', 'Line'), M('amount', 'Amount (KES)')],
        rows: [
          { line: 'Revenue (goods collected, net of discounts)', amount: s.revenue },
          { line: 'Less: cost of goods sold', amount: -s.costOfGoodsSold },
          { line: 'Gross margin', amount: s.grossMargin },
          { line: 'Less: delivery fees', amount: -s.deliveryFees },
          { line: 'Less: telesales pay (retainer + commission)', amount: -s.laborCost },
          { line: 'Less: business expenses (approved)', amount: -s.businessExpenses },
        ],
        totals: { line: 'Net profit', amount: s.netProfit },
      },
      {
        heading: 'By category',
        columns: [T('category', 'Category'), I('units', 'Units'), M('revenue', 'Revenue'), M('cost', 'Cost'), M('margin', 'Margin'), P('margin_percent', 'Margin %')],
        rows: cat.rows,
        totals: { category: 'Total', ...cat.total, margin_percent: cat.total.revenue > 0 ? Math.round((cat.total.margin / cat.total.revenue) * 1000) / 10 : null },
      },
      {
        heading: 'Branch comparison',
        columns: [T('branch', 'Branch'), M('revenue', 'Revenue'), M('costOfGoodsSold', 'Cost of goods'), M('deliveryFees', 'Delivery'), M('laborCost', 'Telesales pay'), M('businessExpenses', 'Expenses'), M('netProfit', 'Net profit'), P('margin_percent', 'Net margin %')],
        rows: branches.rows,
        totals: branches.rows.length > 1 ? { branch: 'All branches', ...branches.total } : undefined,
      },
      {
        heading: 'Forecast vs actual',
        note: 'Operating expenses = delivery + telesales pay + business expenses (everything except cost of goods). The current month is month-to-date.',
        columns: [T('month', 'Month'), M('revenue_target', 'Revenue target'), M('revenue_actual', 'Revenue actual'), M('revenue_variance', 'Variance'), P('revenue_attainment_percent', 'Attained %'),
          M('expense_budget', 'Expense budget'), M('operating_expenses_actual', 'Expenses actual'), M('expense_variance', 'Over(+)/under(-)'), M('net_profit_actual', 'Net profit')],
        rows: fc.rows,
        totals: { month: 'Total (months with a forecast)', ...fc.total },
      },
    ],
  };
}

function discountsDocument({ user, from, to }) {
  const r = extra.discountReport({ storeId: user.storeId, from, to });
  const cols = (first) => [first, I('transactions', 'Transactions'), I('discounted_transactions', 'Discounted'), M('list_value', 'List value'), M('discount', 'Discount'), P('discount_percent', 'Discount %')];
  return {
    title: 'Discount report',
    sections: [
      { heading: 'Summary', columns: [T('line', 'Measure'), T('value', 'Value')], rows: [
        { line: 'Transactions', value: String(r.summary.transactions) },
        { line: 'With a discount', value: String(r.summary.discounted_transactions) },
        { line: 'List value of goods (KES)', value: (r.summary.list_value / 100).toFixed(2) },
        { line: 'Total discount (KES)', value: (r.summary.discount_total / 100).toFixed(2) },
        { line: 'Discount as % of list value', value: r.summary.discount_percent === null ? '-' : `${r.summary.discount_percent}%` },
      ] },
      { heading: 'By staff member', columns: cols(T('staff', 'Staff')), rows: r.by_staff },
      { heading: 'By day', columns: cols(D('date', 'Date')), rows: r.by_day },
      { heading: 'Largest discounts', columns: [D('date', 'Date'), T('kind', 'Type'), T('reference', 'Reference'), T('staff', 'Staff'), T('channel', 'Channel'), M('list_value', 'List value'), M('discount', 'Discount'), P('discount_percent', 'Discount %')], rows: r.largest },
    ],
  };
}

function vatDocument({ user, from, to }) {
  const r = extra.vatReport({ storeId: user.storeId, from, to });
  const cols = (first) => [first, M('gross', 'Sales incl. VAT'), M('net', 'Sales excl. VAT'), M('vat', `VAT @ ${r.vat_rate_percent}%`)];
  return {
    title: 'VAT report (estimate)',
    sections: [
      { heading: 'Total', note: r.note, columns: cols(T('label', 'Period')), rows: [{ label: `${from} to ${to}`, ...r.total }] },
      { heading: 'By month', columns: cols(T('month', 'Month')), rows: r.months, totals: { month: 'Total', ...r.total } },
      { heading: 'By day', columns: cols(D('date', 'Date')), rows: r.daily },
    ],
  };
}

function branchesDocument({ user, from, to }) {
  const r = pnl.byBranch({ user, from, to });
  return {
    title: 'Branch comparison',
    sections: [{
      heading: 'Branches',
      columns: [T('branch', 'Branch'), I('transactions', 'Transactions'), M('revenue', 'Revenue'), M('costOfGoodsSold', 'Cost of goods'), M('deliveryFees', 'Delivery'), M('laborCost', 'Telesales pay'), M('businessExpenses', 'Expenses'), M('netProfit', 'Net profit'), P('margin_percent', 'Net margin %')],
      rows: r.rows,
      totals: r.rows.length > 1 ? { branch: 'All branches', ...r.total } : undefined,
    }],
  };
}

function agentsDocument({ user, from, to }) {
  const r = extra.agentPerformance({ storeId: user.storeId, from, to });
  return {
    title: 'Sales-agent performance',
    sections: [{
      heading: 'Agents ranked by revenue',
      note: 'Online revenue = collected value of dispatched orders assigned to the agent. Leads are those assigned in the period; "Lost" = cancelled.',
      columns: [I('rank', '#'), T('staff', 'Agent'), I('leads_assigned', 'Leads'), I('leads_converted', 'Converted'), I('leads_lost', 'Lost'), P('lead_conversion_percent', 'Conv. %'), I('orders_created', 'Orders'), I('orders_collected', 'Collected'),
        M('online_revenue', 'Online revenue'), M('avg_order_value', 'Avg order'), I('till_sales', 'Till sales'), M('till_revenue', 'Till revenue'), M('total_revenue', 'Total revenue'), M('discounts_given', 'Discounts'), M('commission', 'Commission')],
      rows: r.rows,
      totals: { staff: 'Total', ...r.total },
    }],
  };
}

const BUILDERS = { pnl: pnlDocument, discounts: discountsDocument, vat: vatDocument, branches: branchesDocument, agents: agentsDocument };

function build(report, ctx) {
  const builder = BUILDERS[report];
  if (!builder) throw new ApiError(404, `Unknown report "${report}". Choose one of: ${Object.keys(BUILDERS).join(', ')}.`);
  const settings = settingsService.getAll();
  const doc = builder(ctx);
  return { ...doc, business: settings.business_name || 'Urban Trends', subtitle: `${ctx.from} to ${ctx.to}` };
}

module.exports = { build, REPORTS: Object.keys(BUILDERS) };
