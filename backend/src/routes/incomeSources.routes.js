const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { RATE_LIMITS } = require('../config/limits');
const ctrl = require('../controllers/incomeSources.controller');
const { authenticate, requireRole, requireRecentAuth } = require('../middleware/auth');
const alertOnChange = require('../middleware/alertOnChange');

// connect/test/sync-* all make outbound calls to a third-party API
// (Shopify/WooCommerce) on our behalf. Unlimited access here could be used
// to hammer a connected store's own rate limit or probe its credentials.
// Plain CRUD on the income source row itself doesn't call out anywhere, so
// it stays unlimited like the rest of the authenticated API.
const syncLimiter = rateLimit({ ...RATE_LIMITS.SYNC, standardHeaders: true });

// No browser-redirect OAuth routes needed anymore — the client credentials
// grant is a plain server-to-server POST, so every route here can sit
// behind normal Bearer auth like the rest of the API.
// The whole Settings page (including this) is admin-only in the frontend —
// matching that here too, rather than leaving a wider API surface than the
// UI ever exposes. Income sources hold real third-party API secrets, so
// this is worth being strict about even though nothing in the UI currently
// reaches it with anything less than an admin token.
router.use(authenticate, requireRole('admin'));

router.get('/', ctrl.list);
router.get('/:id', ctrl.getById);
router.post('/', requireRecentAuth(), alertOnChange('Online store connection'), ctrl.create);
router.patch('/:id', requireRecentAuth(), alertOnChange('Online store connection'), ctrl.update);
router.delete('/:id', requireRecentAuth(), alertOnChange('Online store connection (removed)'), ctrl.remove);
router.post('/:id/connect', requireRecentAuth(), syncLimiter, alertOnChange('Online store login details'), ctrl.connect);
router.post('/:id/test', syncLimiter, ctrl.testConnection);
router.post('/:id/sync-products', syncLimiter, ctrl.syncProducts);
router.post('/:id/sync-sales', syncLimiter, ctrl.syncSales);
router.get('/:id/live-sync', ctrl.liveSyncStatus);
router.post('/:id/live-sync/enable', syncLimiter, ctrl.liveSyncEnable);
router.post('/:id/live-sync/disable', syncLimiter, ctrl.liveSyncDisable);

module.exports = router;
