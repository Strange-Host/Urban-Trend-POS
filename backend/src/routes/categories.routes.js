const router = require('express').Router();
const ctrl = require('../controllers/categories.controller');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

router.get('/', ctrl.list);
router.post('/', requirePermission('products.manage'), ctrl.create);
router.put('/:id', requirePermission('products.manage'), ctrl.update);
router.delete('/:id', requirePermission('products.manage'), ctrl.remove);

module.exports = router;
