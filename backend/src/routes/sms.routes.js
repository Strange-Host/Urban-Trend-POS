const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { RATE_LIMITS } = require('../config/limits');
const ctrl = require('../controllers/sms.controller');
const { authenticate, requireRole, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { saveSmsCredentialsSchema, sendTestSmsSchema } = require('../validation/sms.schema');

router.use(authenticate);

// A test send costs real SMS credit and hits a third party — same limiter as
// the other outbound-call admin actions.
const testLimiter = rateLimit({ ...RATE_LIMITS.SYNC, standardHeaders: true });

// Viewing delivery status and retrying a failed message: managers too.
router.get('/status', requirePermission('sms.view'), ctrl.status);
router.get('/outbox', requirePermission('sms.view'), ctrl.listOutbox);
router.post('/outbox/:id/retry', requirePermission('sms.view'), ctrl.retry);

// Credentials and the test send: admin only, like the payment gateway settings.
router.get('/credentials', requireRole('admin'), ctrl.getCredentials);
router.put('/credentials', requireRole('admin'), validate(saveSmsCredentialsSchema), ctrl.saveCredentials);
router.delete('/credentials', requireRole('admin'), ctrl.removeCredentials);
router.post('/test', requireRole('admin'), testLimiter, validate(sendTestSmsSchema), ctrl.sendTest);

module.exports = router;
