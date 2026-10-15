const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { RATE_LIMITS } = require('../config/limits');
const ctrl = require('../controllers/paymentReconciliation.controller');
const webhookAuth = require('../middleware/webhookAuth');
const validate = require('../middleware/validate');
const { webhookNotificationSchema } = require('../validation/paymentReconciliation.schema');

// Generous but bounded — a real payment provider can legitimately send a
// burst of notifications, but this is still an unauthenticated-until-
// webhookAuth-runs endpoint and shouldn't be entirely open to abuse.
const webhookLimiter = rateLimit({ ...RATE_LIMITS.WEBHOOK, standardHeaders: true });

router.use(webhookLimiter);

router.post('/kcb/webhook', webhookAuth('kcb'), validate(webhookNotificationSchema), ctrl.kcbWebhook);
router.post('/mpesa/webhook', webhookAuth('mpesa'), validate(webhookNotificationSchema), ctrl.mpesaWebhook);

module.exports = router;
