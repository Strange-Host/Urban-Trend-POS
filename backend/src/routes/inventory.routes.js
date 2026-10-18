const router = require('express').Router();
const ctrl = require('../controllers/inventory.controller');
const { authenticate, requireRole, requirePermission, requireRecentAuth } = require('../middleware/auth');

router.use(authenticate);

router.get('/', ctrl.list);
router.get('/low-stock', ctrl.lowStock);
router.get('/reconcile', requirePermission('inventory.adjust'), ctrl.checkReconciliation);
router.post('/reconcile', requireRole('admin'), ctrl.runReconciliation);
router.get('/:productId/movements', ctrl.movements);
router.post('/adjust', requirePermission('inventory.adjust'), requireRecentAuth(), ctrl.adjust);

module.exports = router;
