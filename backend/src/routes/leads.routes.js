const router = require('express').Router();
const ctrl = require('../controllers/leads.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// "Manage CRM leads": admin, manager, cashier can all touch leads (§5.2) —
// cashiers are scoped to their own assigned leads at the controller/service level.
router.use(authenticate, requireRole('admin', 'manager', 'cashier'));

router.get('/stats', ctrl.stats);
router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.get('/:id', ctrl.getById);
router.patch('/:id', ctrl.update);
router.delete('/:id', ctrl.remove);
router.post('/:id/activities', ctrl.addActivity);
router.patch('/:id/status', ctrl.changeStatus);

module.exports = router;
