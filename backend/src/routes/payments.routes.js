const router = require('express').Router();
const ctrl = require('../controllers/payments.controller');
const { authenticate, requirePermission, requireRecentAuth } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createPaymentSchema } = require('../validation/payments.schema');

// Recording/refunding money movement is a financial action — admin/manager only,
// matching the matrix's "View Payments/reconciliation" row (§5.2).
router.use(authenticate, requirePermission('payments.manage'));

router.get('/summary', ctrl.summary);
router.get('/', ctrl.list);
router.post('/', validate(createPaymentSchema), ctrl.create);
router.post('/:id/refund', requireRecentAuth(), ctrl.refund);

module.exports = router;
