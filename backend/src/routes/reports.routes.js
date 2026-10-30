const router = require('express').Router();
const ctrl = require('../controllers/reports.controller');
const extra = require('../controllers/reportsExtra.controller');
const { authenticate, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { forecastSchema } = require('../validation/reports.schema');

router.use(authenticate, requirePermission('reports.view'));

router.get('/sales-summary', ctrl.salesSummary);
router.get('/top-products', ctrl.topProducts);
router.get('/inventory-value', ctrl.inventoryValue);
router.get('/sales-by-channel', ctrl.salesByChannel);
router.get('/sales-trend', ctrl.salesTrend);
router.get('/payment-methods', ctrl.paymentMethods);
router.get('/top-products-by-channel', ctrl.topProductsByChannel);
// Phase 9 — the inventory-management "home screen" reports, combining POS + online orders.
router.get('/dashboard-overview', ctrl.dashboardOverview);
router.get('/unpaid-parcels', ctrl.unpaidParcels);
router.get('/profit-summary', ctrl.profitSummary);
router.get('/top-products-by-profit', ctrl.topProductsByProfit);
router.get('/top-staff-by-profit', ctrl.topStaffByProfit);

// Priority 5: the full P&L, the missing reports, forecasts, and Excel/PDF export.
router.get('/pnl', extra.fullPnl);
router.get('/discounts', extra.discounts);
router.get('/vat', extra.vat);
router.get('/branch-comparison', extra.branchComparison);
router.get('/agent-performance', extra.agents);
router.get('/forecasts', extra.listForecasts);
router.put('/forecasts/:month', requirePermission('reports.forecast'), validate(forecastSchema), extra.setForecast);
router.get('/export/:report', extra.exportReport);

module.exports = router;
