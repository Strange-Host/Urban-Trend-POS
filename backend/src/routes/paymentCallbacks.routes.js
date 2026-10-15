const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { RATE_LIMITS } = require('../config/limits');
const ctrl = require('../controllers/paymentCallbacks.controller');
const webhookPathAuth = require('../middleware/webhookPathAuth');

// Same headroom as the normalized webhook — Safaricom in particular
// retries Confirmation deliveries that don't ack fast enough.
const webhookLimiter = rateLimit({ ...RATE_LIMITS.WEBHOOK, standardHeaders: true });
router.use(webhookLimiter);

// The URLs we actually REGISTER with Safaricom use the neutral "c2b" segment.
// Safaricom's API rejects any validation/confirmation/callback URL containing
// the words "mpesa" or "safaricom" (any case) - confirmed against the live
// sandbox ("Invalid ValidationURL - URL has the word MPESA") - so a path like
// /callbacks/mpesa/<secret>/confirmation can never be registered.
router.post('/c2b/:token/validation', webhookPathAuth('mpesa'), ctrl.mpesaValidation);
router.post('/c2b/:token/confirmation', webhookPathAuth('mpesa'), ctrl.mpesaConfirmation);
router.post('/c2b/:token/stk', webhookPathAuth('mpesa'), ctrl.mpesaStkCallback);

// Legacy /mpesa/ spellings stay mounted so anything already pointing at them
// (a hand-registered URL, an earlier version's STK request still in flight)
// keeps working. New registrations never use them.
router.post('/mpesa/:token/validation', webhookPathAuth('mpesa'), ctrl.mpesaValidation);
router.post('/mpesa/:token/confirmation', webhookPathAuth('mpesa'), ctrl.mpesaConfirmation);
router.post('/mpesa/:token/stk', webhookPathAuth('mpesa'), ctrl.mpesaStkCallback);
router.post('/kcb/:token/callback', webhookPathAuth('kcb'), ctrl.kcbCallback);

module.exports = router;
