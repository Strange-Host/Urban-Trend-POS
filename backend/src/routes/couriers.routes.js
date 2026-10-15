const router = require('express').Router();
const ctrl = require('../controllers/couriers.controller');
const { authenticate, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createCourierSchema, updateCourierSchema } = require('../validation/couriers.schema');

router.use(authenticate);

router.get('/', ctrl.list); // any signed-in user: the order screen needs the picker
router.post('/', requirePermission('couriers.manage'), validate(createCourierSchema), ctrl.create);
router.patch('/:id', requirePermission('couriers.manage'), validate(updateCourierSchema), ctrl.update);
router.delete('/:id', requirePermission('couriers.manage'), ctrl.remove);

module.exports = router;
