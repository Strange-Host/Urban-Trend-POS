const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const validate = require('../../middleware/validate');
const { authenticate, requirePermission, requireAnyPermission } = require('../../middleware/auth');
const { RATE_LIMITS } = require('../../config/limits');
const SqliteRateLimitStore = require('../../utils/sqliteRateLimitStore');
const mobileAuth = require('../../controllers/mobileAuth.controller');
const devices = require('../../controllers/devices.controller');
const home = require('../../controllers/home.controller');
const appVersion = require('../../controllers/appVersion.controller');
const schema = require('../../validation/mobile.schema');
const api = require('../../controllers/mobileApi.controller');
const v11 = require('../../validation/mobile.v11.schema');
const catalog = require('../../controllers/mobileCatalog.controller');
const bulkPrice = require('../../controllers/mobileBulkPrice.controller');

// The mobile app's API, mounted at /api/v1 (app.js). The rule for this prefix: fields may be ADDED to responses and
// endpoints may be added, but nothing here is renamed or removed while an older app might still be installed - that
// is what keeps the app from needing an update every time the POS changes. A breaking change goes to /api/v2.

// Sign-in guesses share the web login's allowance (same scope), so an attacker gains nothing by switching doors.
const loginLimiter = rateLimit({
  ...RATE_LIMITS.LOGIN, standardHeaders: true,
  store: new SqliteRateLimitStore({ scope: 'login' }), passOnStoreError: true,
});

router.post('/auth/mobile/login', loginLimiter, validate(schema.mobileLogin), mobileAuth.login);
router.post('/auth/mobile/verify-otp', loginLimiter, validate(schema.mobileVerifyOtp), mobileAuth.verifyOtp);
router.post('/auth/mobile/refresh', validate(schema.refreshBody), mobileAuth.refresh);
router.post('/auth/mobile/logout', validate(schema.refreshBody), mobileAuth.logout);

// Public: the app asks this before anyone is signed in (and an app too old to sign in must still be able to read it).
router.get('/app/version', appVersion.get);
router.get('/openapi.json', require('../../controllers/openapi.controller').get);

router.get('/home/attention', authenticate, home.attention);
router.get('/home/summary', authenticate, home.summary);

router.post('/devices', authenticate, validate(schema.registerDevice), devices.register);
router.get('/devices', authenticate, devices.list);
router.delete('/devices/:id', authenticate, devices.revoke);

// ---- approvals: anyone who can decide at least one kind sees the list; the service then shows and allows only the kinds
// their own permissions cover (void/refund: approvals.review, expense: expenses.approve, requisition: requisitions.approve,
// large stock change: inventory.approve_adjust), and never their own requests.
const DECIDER = requireAnyPermission('approvals.review', 'expenses.approve', 'requisitions.approve', 'inventory.approve_adjust');
router.get('/approvals', authenticate, DECIDER, api.approvalsList);
router.post('/approvals/:id/approve', authenticate, DECIDER, validate(schema.approveBody), api.approve);
router.post('/approvals/:id/reject', authenticate, DECIDER, validate(schema.rejectBody), api.reject);

// ---- alerts: your own bell rows, so no permission beyond being signed in.
router.get('/notifications', authenticate, api.notifications);

// ---- stock
router.get('/stock/lookup', authenticate, requireAnyPermission('inventory.adjust', 'stock.review', 'stock.receive'), api.stockLookup);
router.post('/stock/adjustments', authenticate, requirePermission('inventory.adjust'), validate(schema.stockAdjustment), api.stockAdjustment);

// ---- orders (read-only)
router.get('/orders', authenticate, requirePermission('orders.view'), api.orders);
router.get('/orders/:id', authenticate, requirePermission('orders.view'), api.order);

// ---- your own app preferences
router.get('/me/preferences', authenticate, api.getPreferences);
router.put('/me/preferences', authenticate, validate(schema.preferences), api.putPreferences);

// ---- the app file itself. Upload and link-making are owner actions; downloading needs a sign-in or a signed link.
router.post('/app/apk', authenticate, requirePermission('app.manage'), api.uploadApk);
router.get('/app/apk', authenticate, api.downloadApk);
router.post('/app/download-links', authenticate, requirePermission('app.manage'), api.makeLink);
router.get('/app/download', api.downloadByLink);
// ---- v1.1: catalog, categories, bulk prices. Every route re-checks its permission on the server.
const manage = requirePermission('products.manage');
const bulkKey = requirePermission('prices.bulk');
router.get('/products', authenticate, manage, catalog.list);
router.post('/products', authenticate, manage, validate(v11.createProduct), catalog.create);
router.get('/products/:id', authenticate, manage, catalog.get);
router.patch('/products/:id', authenticate, manage, validate(v11.patchProduct), catalog.patch);
router.get('/products/:id/price-history', authenticate, manage, catalog.history);
router.get('/catalog/settings', authenticate, manage, catalog.catalogSettings);
router.get('/categories', authenticate, manage, catalog.listCategories);
router.post('/categories', authenticate, manage, validate(v11.createCategory), catalog.createCategory);
router.post('/categories/reorder', authenticate, manage, validate(v11.reorderCategories), catalog.reorderCategories);
router.patch('/categories/:id', authenticate, manage, validate(v11.patchCategory), catalog.patchCategory);
router.post('/prices/bulk/preview', authenticate, bulkKey, validate(v11.bulkChange), bulkPrice.preview);
router.post('/prices/bulk/apply', authenticate, bulkKey, validate(v11.bulkApply), bulkPrice.apply);
router.get('/prices/bulk/batches', authenticate, bulkKey, bulkPrice.batches);
router.post('/prices/bulk/:batchId/revert', authenticate, bulkKey, validate(v11.bulkRevert), bulkPrice.revert);

module.exports = router;
