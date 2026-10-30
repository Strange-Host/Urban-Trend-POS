const router = require('express').Router();
const ctrl = require('../controllers/deliveryAreas.controller');
const { authenticate, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createAreaSchema, updateAreaSchema, importAreasSchema } = require('../validation/deliveryAreas.schema');

router.use(authenticate);

router.get('/', ctrl.list);            // any signed-in user: the order screen shows the fee
router.get('/lookup', ctrl.lookup);
router.post('/', requirePermission('couriers.manage'), validate(createAreaSchema), ctrl.create);
router.post('/import', requirePermission('couriers.manage'), validate(importAreasSchema), ctrl.importRows);
router.patch('/:id', requirePermission('couriers.manage'), validate(updateAreaSchema), ctrl.update);
router.delete('/:id', requirePermission('couriers.manage'), ctrl.remove);

module.exports = router;
