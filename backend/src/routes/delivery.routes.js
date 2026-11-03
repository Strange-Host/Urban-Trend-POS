const router = require('express').Router();
const ctrl = require('../controllers/delivery.controller');
const { authenticate, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { reverseDeliveryCostSchema, rejectDeliveryCostSchema } = require('../validation/delivery.schema');

router.use(authenticate);

// Per-delivery earnings and costs, and the queue of extra costs waiting for a second person.
router.get('/settlements', requirePermission('delivery.costs.approve'), ctrl.list);
router.get('/costs/pending', requirePermission('delivery.costs.approve'), ctrl.pending);
router.post('/costs/:costId/approve', requirePermission('delivery.costs.approve'), ctrl.approve);
router.post('/costs/:costId/reject', requirePermission('delivery.costs.approve'), validate(rejectDeliveryCostSchema), ctrl.reject);
router.post('/costs/:costId/reverse', requirePermission('delivery.costs.record'), validate(reverseDeliveryCostSchema), ctrl.reverse);

module.exports = router;
