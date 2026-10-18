const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { RATE_LIMITS } = require('../config/limits');
const ctrl = require('../controllers/paymentGatewayCredentials.controller');
const { authenticate, requireRole, requireRecentAuth } = require('../middleware/auth');
const alertOnChange = require('../middleware/alertOnChange');
const validate = require('../middleware/validate');
const { simulateMpesaSchema, stkPushSchema } = require('../validation/paymentReconciliation.schema');

// Same admin-only gating as the rest of Settings.
router.use(authenticate, requireRole('admin'));

// These three make outbound calls to Safaricom/KCB, same reasoning as
// income_sources' syncLimiter — bound how often an admin session can
// hammer a third party's own rate limit or probe credentials.
const actionLimiter = rateLimit({ ...RATE_LIMITS.SYNC, standardHeaders: true });

router.get('/', ctrl.list);
router.get('/:provider', ctrl.getByProvider);
router.put('/:provider', requireRecentAuth(), alertOnChange('Payment provider details'), ctrl.upsert);
router.delete('/:provider', requireRecentAuth(), alertOnChange('Payment provider (switched off)'), ctrl.deactivate);
router.post('/:provider/test', actionLimiter, ctrl.testConnection);
router.post('/mpesa/register-urls', actionLimiter, ctrl.registerMpesaUrls);
router.post('/mpesa/simulate', actionLimiter, validate(simulateMpesaSchema), ctrl.simulateMpesaPayment);
router.post('/mpesa/stk-push', actionLimiter, validate(stkPushSchema), ctrl.initiateMpesaStkPush);

module.exports = router;
