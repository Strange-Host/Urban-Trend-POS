const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/reports.service');

// GET /api/reports/sales-summary?from=&to=
const salesSummary = asyncHandler(async (req, res) => {
  res.json(svc.salesSummary({ query: req.query, user: req.user }));
});

// GET /api/reports/top-products?from=&to=&limit=10
const topProducts = asyncHandler(async (req, res) => {
  res.json(svc.topProducts({ query: req.query, user: req.user }));
});

// GET /api/reports/inventory-value
const inventoryValue = asyncHandler(async (req, res) => {
  res.json(svc.inventoryValue({ user: req.user }));
});

// GET /api/reports/inventory-valuation?store_id=
const inventoryValuation = asyncHandler(async (req, res) => {
  res.json(svc.inventoryValuation({ user: req.user, query: req.query }));
});

// GET /api/reports/sales-by-channel?from=&to=  — revenue split across the
const salesByChannel = asyncHandler(async (req, res) => {
  res.json(svc.salesByChannel({ query: req.query, user: req.user }));
});

// GET /api/reports/sales-trend?from=&to=  — daily revenue series, split by channel type,
const salesTrend = asyncHandler(async (req, res) => {
  res.json(svc.salesTrend({ query: req.query, user: req.user }));
});

// GET /api/reports/payment-methods?from=&to=
const paymentMethods = asyncHandler(async (req, res) => {
  res.json(svc.paymentMethods({ query: req.query, user: req.user }));
});

// GET /api/reports/top-products-by-channel?from=&to=&limit=10 — same as
const topProductsByChannel = asyncHandler(async (req, res) => {
  res.json(svc.topProductsByChannel({ query: req.query, user: req.user }));
});

// GET /api/reports/dashboard-overview?date=YYYY-MM-DD (defaults to today)
const dashboardOverview = asyncHandler(async (req, res) => {
  res.json(svc.dashboardOverview({ query: req.query, user: req.user }));
});

// GET /api/reports/unpaid-parcels?courier=boda|g4s — the row-level detail
const unpaidParcels = asyncHandler(async (req, res) => {
  res.json(svc.unpaidParcels({ user: req.user, query: req.query }));
});

// GET /api/reports/top-products-by-profit?from=&to=&limit=10 — combines
const topProductsByProfit = asyncHandler(async (req, res) => {
  res.json(svc.topProductsByProfit({ user: req.user, query: req.query }));
});

// GET /api/reports/top-staff-by-profit?from=&to=&limit=10 — telesales reps
const topStaffByProfit = asyncHandler(async (req, res) => {
  res.json(svc.topStaffByProfit({ user: req.user, query: req.query }));
});

module.exports = { salesSummary, topProducts, inventoryValue, inventoryValuation, salesByChannel, salesTrend, paymentMethods, topProductsByChannel, dashboardOverview, unpaidParcels, topProductsByProfit, topStaffByProfit };
