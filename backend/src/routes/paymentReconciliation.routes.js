const router = require('express').Router();
const ctrl = require('../controllers/paymentReconciliation.controller');
const { authenticate, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { manualMatchSchema } = require('../validation/paymentReconciliation.schema');

// Payment reconciliation is money-handling — admin/manager only, same
// justification as requireRole on inventory's /reconcile endpoints.
router.use(authenticate, requirePermission('payments.reconcile'));

router.get('/unmatched', ctrl.listUnmatched);
router.post('/:id/match', validate(manualMatchSchema), ctrl.manualMatch);
router.post('/:id/ignore', ctrl.ignore);

module.exports = router;
