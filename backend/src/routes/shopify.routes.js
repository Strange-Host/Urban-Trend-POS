const router = require('express').Router();
const ctrl = require('../controllers/shopify.controller');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate, requirePermission('shopify.sync'));

router.get('/connections', ctrl.connections);
router.post('/sync', ctrl.sync);
router.get('/staging', ctrl.listStaging);
router.patch('/staging/:id', ctrl.updateStaging);
router.post('/staging/:id/approve', ctrl.approve);
router.post('/staging/:id/reject', ctrl.reject);
router.post('/staging/approve-all', ctrl.approveAll);

module.exports = router;
