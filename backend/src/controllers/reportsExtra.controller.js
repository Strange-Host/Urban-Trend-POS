const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const pnl = require('../services/reportsPnl.service');
const extra = require('../services/reportsExtra.service');
const documents = require('../services/reportDocuments.service');
const { toXlsx, toPdf } = require('../utils/reportExport');
const { localDate, dateParam } = require('../utils/storeTime');

const range = (req) => {
  const from = dateParam(req.query.from, 'from', localDate(29));
  const to = dateParam(req.query.to, 'to', localDate(0));
  if (from > to) throw new ApiError(400, 'from must be on or before to.');
  return { from, to };
};

// GET /api/reports/pnl?from=&to= — the full P&L: summary, by category, branch comparison, forecast vs actual.
const fullPnl = asyncHandler(async (req, res) => {
  const { from, to } = range(req);
  res.json({ data: {
    summary: pnl.profitLoss({ storeId: req.user.storeId, from, to }),
    byCategory: pnl.byCategory({ storeId: req.user.storeId, from, to }),
    byBranch: pnl.byBranch({ user: req.user, from, to }),
    forecast: pnl.forecastVsActual({ storeId: req.user.storeId, from, to }),
  } });
});

const branchComparison = asyncHandler(async (req, res) => {
  const { from, to } = range(req);
  res.json({ data: { period: { from, to }, ...pnl.byBranch({ user: req.user, from, to }) } });
});

const discounts = asyncHandler(async (req, res) => {
  const { from, to } = range(req);
  res.json({ data: extra.discountReport({ storeId: req.user.storeId, from, to }) });
});

const vat = asyncHandler(async (req, res) => {
  const { from, to } = range(req);
  res.json({ data: extra.vatReport({ storeId: req.user.storeId, from, to }) });
});

const agents = asyncHandler(async (req, res) => {
  const { from, to } = range(req);
  res.json({ data: extra.agentPerformance({ storeId: req.user.storeId, from, to }) });
});

const listForecasts = asyncHandler(async (req, res) => {
  const { from, to } = range(req);
  res.json({ data: pnl.listForecasts({ storeId: req.user.storeId, from, to }) });
});

const setForecast = asyncHandler(async (req, res) => {
  const { revenue_target, expense_budget, notes } = req.body;
  res.json({ data: pnl.setForecast({ storeId: req.user.storeId, staffId: req.user.id, month: req.params.month, revenueTarget: revenue_target, expenseBudget: expense_budget, notes }) });
});

// GET /api/reports/export/:report?format=xlsx|pdf&from=&to=
const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};
const exportReport = asyncHandler(async (req, res) => {
  const format = String(req.query.format || 'xlsx').toLowerCase();
  if (!MIME[format]) throw new ApiError(400, 'format must be xlsx or pdf.');
  const { from, to } = range(req);
  const doc = documents.build(req.params.report, { user: req.user, from, to });
  const buffer = format === 'xlsx' ? await toXlsx(doc) : await toPdf(doc);
  res.setHeader('Content-Type', MIME[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.report}_${from}_to_${to}.${format}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
});

module.exports = { fullPnl, branchComparison, discounts, vat, agents, listForecasts, setForecast, exportReport };
