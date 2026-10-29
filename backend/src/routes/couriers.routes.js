const router = require('express').Router();
const ctrl = require('../controllers/couriers.controller');
const { authenticate, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createCourierSchema, updateCourierSchema, recordCollectionSchema, createStatementSchema } = require('../validation/couriers.schema');

router.use(authenticate);

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
