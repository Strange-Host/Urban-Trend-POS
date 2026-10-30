const router = require('express').Router();
const ctrl = require('../controllers/pettyCash.controller');
const { authenticate, requirePermission, requireAnyPermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createTopupSchema } = require('../validation/pettyCash.schema');

router.use(authenticate);

router.get('/', requireAnyPermission('expenses.manage', 'expenses.approve'), ctrl.overview);
router.post('/topups', requirePermission('expenses.manage'), validate(createTopupSchema), ctrl.createTopup);
router.post('/topups/:id/approve', requirePermission('expenses.approve'), ctrl.approveTopup);
router.post('/topups/:id/reject', requirePermission('expenses.approve'), ctrl.rejectTopup);

module.exports = router;
