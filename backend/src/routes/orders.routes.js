const requireModule = require('../middleware/requireModule');
const router = require('express').Router();
const ctrl = require('../controllers/orders.controller');
const { authenticate, requireRole, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const {
  createOrderSchema, mergeItemsSchema, setCourierSchema, recordPaymentSchema, shopCashSchema, inspectReturnSchema,
  notesOnlySchema, returnedInTransitSchema, ownerDecisionSchema, openDisputeSchema, resolveDisputeSchema,
} = require('../validation/orders.schema');

// Same role shape as leads (§5.2): admin/manager/cashier can all work
// online orders; scoping to "own assigned orders only" for cashiers can
// follow the same pattern leads.service uses once telesales distribution
// (Phase 5) lands — not needed for Phase 1's core lifecycle.
router.use(authenticate, requireRole('admin', 'manager', 'cashier'));

// Pull to-ship orders from a connected Shopify/WooCommerce store into this workflow.
// These two static paths must sit before '/:id'. Rate-limited like the other sync actions.
const pullLimiter = require('express-rate-limit')({ ...require('../config/limits').RATE_LIMITS.SYNC, standardHeaders: true });
router.get('/online-sources', requirePermission('orders.pull_online'), require('../controllers/onlineOrders.controller').sources);
router.post('/pull-online', pullLimiter, requirePermission('orders.pull_online'), require('../controllers/onlineOrders.controller').pull);

router.get('/', ctrl.list);
// Must come before GET /:id — otherwise Express matches "pending-owner-decision" as an :id.
router.get('/pending-owner-decision', requireRole('admin', 'manager'), ctrl.listPendingOwnerDecisions);
// Also before '/:id'. Detect-only check that every order's lines add up to its subtotal.
router.get('/integrity', requireRole('admin', 'manager'), ctrl.checkIntegrity);
// Also before '/:id'. The manager's money-at-risk list (see services/atRisk.service.js).
router.get('/at-risk', requirePermission('atrisk.view'), ctrl.atRisk);
router.post('/', validate(createOrderSchema), ctrl.create);
router.get('/:id', ctrl.getById);
router.post('/:id/merge-items', validate(mergeItemsSchema), ctrl.mergeItems);
router.post('/:id/confirm-cod', ctrl.confirmCod);
router.get('/:id/receipt', require('../controllers/receipts.controller').orderReceipt);
router.get('/:id/invoice.pdf', require('../controllers/receipts.controller').orderInvoice);
router.post('/:id/courier', validate(setCourierSchema), ctrl.setCourier);
router.post('/:id/dispatch', ctrl.dispatch);
router.post('/:id/payments', validate(recordPaymentSchema), ctrl.recordPayment);
// Cash taken at the shop: needs a reason, is capped at what the order owes, and the taker holds it until it is deposited (see custody.service.js).
router.post('/:id/shop-cash', validate(shopCashSchema), ctrl.recordShopCash);
router.post('/:id/returned-in-transit', validate(returnedInTransitSchema), ctrl.markReturnedInTransit);
router.post('/:id/returned-awaiting-inspection', ctrl.markReturnedAwaitingInspection);
// Inspection decides whether stock comes back — manager/admin only (§6 RMA: "Manager approval required for resale").
router.post('/:id/inspect', requirePermission('orders.inspect'), validate(inspectReturnSchema), ctrl.inspectReturn);
// Write-off/disposal is an owner-level call, stricter than inspection — admin only (no separate "owner" role exists in this app; admin is the highest one there is).
router.post('/:id/owner-decision', requireRole('admin'), validate(ownerDecisionSchema), ctrl.decideOwnerAction);
// Disputes: any staff can raise one, but resolving one (issuing a refund/redelivery call) is manager/admin.
router.post('/:id/dispute', requireModule('control'), validate(openDisputeSchema), ctrl.openDispute);
router.post('/:id/dispute/resolve', requireModule('control'), requirePermission('orders.resolve_dispute'), validate(resolveDisputeSchema), ctrl.resolveDispute);
router.post('/:id/cancel', validate(notesOnlySchema), ctrl.cancel);
// Manual trigger for the COD auto-expiry sweep server.js also runs every 15 minutes.
router.post('/expire-unconfirmed', requireRole('admin'), ctrl.expireUnconfirmed);

module.exports = router;
