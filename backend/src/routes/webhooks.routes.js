const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const ctrl = require('../controllers/webhooks.controller');

// A busy store can fire hundreds of order/product events in a burst (an import, a bulk edit), so this
// limit is deliberately roomier than the payment-callback one. Signature checking is the real gate.
const limiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 3000, standardHeaders: true });

router.post('/shopify/:sourceId', limiter, ctrl.shopify);
router.post('/woocommerce/:sourceId', limiter, ctrl.woocommerce);

module.exports = router;
