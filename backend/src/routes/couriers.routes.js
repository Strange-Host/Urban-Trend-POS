const router = require('express').Router();
const ctrl = require('../controllers/couriers.controller');
const { authenticate, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createCourierSchema, updateCourierSchema, recordCollectionSchema, createStatementSchema } = require('../validation/couriers.schema');
const payables = require('../controllers/courierPayables.controller');
const { recordCostSchema, rejectCostSchema, payoutSchema } = require('../validation/courierPayables.schema');

router.use(authenticate);

// Payables. A package fee is entered at dispatch (POST /api/orders/:id/dispatch), not here.
router.get('/payables', requirePermission('couriers.pay'), payables.summary);
router.get('/costs', requirePermission('couriers.costs.approve'), payables.listCosts);
router.post('/costs/:costId/approve', requirePermission('couriers.costs.approve'), payables.approveCost);
router.post('/costs/:costId/reject', requirePermission('couriers.costs.approve'), validate(rejectCostSchema), payables.rejectCost);
router.get('/payouts', requirePermission('couriers.pay'), payables.listPayouts);
router.get('/payouts/:payoutId', requirePermission('couriers.pay'), payables.getPayout);
router.get('/:id/payables', requirePermission('couriers.pay'), payables.balance);
router.post('/:id/costs', requirePermission('couriers.costs.record'), validate(recordCostSchema), payables.recordCost);
router.post('/:id/payouts', requirePermission('couriers.pay'), validate(payoutSchema), payables.createPayout);

router.get('/', ctrl.list); // any signed-in user: the order screen needs the picker
router.post('/', requirePermission('couriers.manage'), validate(createCourierSchema), ctrl.create);
router.patch('/:id', requirePermission('couriers.manage'), validate(updateCourierSchema), ctrl.update);
router.delete('/:id', requirePermission('couriers.manage'), ctrl.remove);

// Courier organizations: what they hold, what they collected, and settling their statements.
router.get('/:id/standing', requirePermission('couriers.settle'), ctrl.standing);
router.get('/:id/collections', requirePermission('couriers.settle'), ctrl.openCollections);
router.post('/:id/collections', requirePermission('couriers.settle'), validate(recordCollectionSchema), ctrl.recordCollection);
router.get('/:id/statements', requirePermission('couriers.settle'), ctrl.statements);
router.post('/:id/statements', requirePermission('couriers.settle'), validate(createStatementSchema), ctrl.createStatement);

module.exports = router;
