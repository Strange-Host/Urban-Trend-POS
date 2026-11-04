const router = require('express').Router();
const ctrl = require('../controllers/delivery.controller');
const { authenticate, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { reverseDeliveryCostSchema, rejectDeliveryCostSchema, verifyReceiptSchema } = require('../validation/delivery.schema');

router.use(authenticate);

// Per-delivery earnings and costs, and the queue of extra costs waiting for a second person.
router.get('/settlements', requirePermission('delivery.costs.approve'), ctrl.list);
router.get('/costs/pending', requirePermission('delivery.costs.approve'), ctrl.pending);
router.post('/costs/:costId/approve', requirePermission('delivery.costs.approve'), ctrl.approve);
router.post('/costs/:costId/reject', requirePermission('delivery.costs.approve'), validate(rejectDeliveryCostSchema), ctrl.reject);
router.post('/costs/:costId/reverse', requirePermission('delivery.costs.record'), validate(reverseDeliveryCostSchema), ctrl.reverse);

router.post('/adjustments/:adjustmentId/approve', requirePermission('delivery.costs.approve'), ctrl.approveAdjustment);
router.post('/adjustments/:adjustmentId/reject', requirePermission('delivery.costs.approve'), validate(rejectDeliveryCostSchema), ctrl.rejectAdjustment);

// Fee payments that still need confirming as real money (cash deposited, mobile/bank payment seen).
router.get('/fee-receipts/unverified', requirePermission('delivery.costs.approve'), ctrl.unverifiedReceipts);
router.post('/fee-receipts/:receiptId/verify', requirePermission('delivery.costs.approve'), validate(verifyReceiptSchema), ctrl.verifyReceipt);

module.exports = router;
