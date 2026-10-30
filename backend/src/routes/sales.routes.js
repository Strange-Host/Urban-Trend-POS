const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { RATE_LIMITS } = require('../config/limits');
const ctrl = require('../controllers/sales.controller');
const { authenticate, requireRole, requirePermission, requireRecentAuth } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { checkoutSchema } = require('../validation/sales.schema');

// The storekeeper ('store') role has no till: it cannot ring up or browse sales.
router.use(authenticate, requireRole('admin', 'manager', 'cashier'));

// Generous limit — a busy register can legitimately ring up many sales in
// a window — but checkout is the one high-frequency endpoint that writes
// money and stock, so it shouldn't be entirely unbounded like a read.
const checkoutLimiter = rateLimit({ ...RATE_LIMITS.CHECKOUT, standardHeaders: true });

router.post('/', checkoutLimiter, validate(checkoutSchema), ctrl.checkout);
router.get('/', ctrl.list);
router.get('/:id', ctrl.getById);
router.get('/:id/receipt', require('../controllers/receipts.controller').saleReceipt);
router.post('/:id/void', requirePermission('sales.void'), requireRecentAuth(), ctrl.voidSale);

module.exports = router;
