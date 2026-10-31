const router = require('express').Router();
const ctrl = require('../controllers/suppliers.controller');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

router.get('/', requirePermission('stock.receive'), ctrl.list);
router.post('/', requirePermission('stock.receive'), ctrl.create);
// Renaming or switching a supplier off is for people who manage products.
router.put('/:id', requirePermission('products.manage'), ctrl.update);

module.exports = router;
