const router = require('express').Router();
const ctrl = require('../controllers/categories.controller');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

router.get('/', ctrl.list);
router.post('/', requirePermission('products.manage'), ctrl.create);
router.put('/:id', requirePermission('products.manage'), ctrl.update);
router.get('/:id/usage', requirePermission('products.manage'), ctrl.usage);
router.post('/:id/archive', requirePermission('products.manage'), ctrl.archive);
router.post('/:id/restore', requirePermission('products.manage'), ctrl.restore);
router.delete('/:id', requirePermission('products.manage'), ctrl.remove);

module.exports = router;
