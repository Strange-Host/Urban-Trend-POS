const router = require('express').Router();
const ctrl = require('../controllers/approvals.controller');
const { authenticate, requirePermission, requireAnyPermission, requireRecentAuth } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createApprovalSchema, rejectApprovalSchema } = require('../validation/approvals.schema');

// Anyone who can ask for a void/refund, or decide on one, can open this. What each person may do (which kind they can
// request, which they can approve) is decided per request in services/approvals.service.js.
router.use(authenticate, requireAnyPermission('approvals.review', 'sales.void_request', 'payments.refund_request'));

router.get('/', ctrl.list);
router.post('/', validate(createApprovalSchema), ctrl.create);
// Approving moves money / stock, so it asks for the password again like the direct void and refund do.
router.post('/:id/approve', requirePermission('approvals.review'), requireRecentAuth(), ctrl.approve);
router.post('/:id/reject', requirePermission('approvals.review'), validate(rejectApprovalSchema), ctrl.reject);
router.post('/:id/cancel', ctrl.cancel);

module.exports = router;
