const router = require('express').Router();
const ctrl = require('../controllers/products.controller');
const { authenticate, requirePermission, requireAnyPermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createProductSchema, updateProductSchema } = require('../validation/products.schema');

router.use(authenticate);

router.get('/', ctrl.list);
router.get('/barcode/:code', ctrl.getByBarcode);
// Proposals waiting for approval. Declared before '/:id' so "pending" is not read as an id.
router.get('/pending/list', requireAnyPermission('products.approve', 'products.propose'), ctrl.listPending);
router.get('/:id', ctrl.getById);
// Creating is open to anyone who can manage products (created straight away) or propose them (created pending).
router.post('/', requireAnyPermission('products.manage', 'products.propose'), validate(createProductSchema), ctrl.create);
router.post('/:id/approve', requirePermission('products.approve'), ctrl.approve);
router.post('/:id/reject', requirePermission('products.approve'), ctrl.reject);
router.put('/:id', requirePermission('products.manage'), validate(updateProductSchema), ctrl.update);
router.delete('/:id', requirePermission('products.manage'), ctrl.remove);

module.exports = router;
