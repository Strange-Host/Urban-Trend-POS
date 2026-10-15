const router = require('express').Router();
const ctrl = require('../controllers/requisitions.controller');
const { authenticate, requireRole, requirePermission } = require('../middleware/auth');

router.use(authenticate);

// All three roles can create requisitions (§5.2); only manager/admin review.
router.get('/', requireRole('admin', 'manager', 'cashier'), ctrl.list);
router.post('/', requireRole('admin', 'manager', 'cashier'), ctrl.create);
router.get('/:id', requireRole('admin', 'manager', 'cashier'), ctrl.getById);
router.patch('/:id/approve', requirePermission('requisitions.approve'), ctrl.approve);
router.patch('/:id/reject', requirePermission('requisitions.approve'), ctrl.reject);

module.exports = router;
