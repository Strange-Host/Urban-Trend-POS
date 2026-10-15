const router = require('express').Router();
const ctrl = require('../controllers/expenses.controller');
const { authenticate, requirePermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createExpenseSchema, updateExpenseSchema } = require('../validation/expenses.schema');

// Decided: cashiers cannot record expenses — manager/admin only (§5.2 footnote).
router.use(authenticate, requirePermission('expenses.manage'));

router.get('/categories', ctrl.listCategories);
router.post('/categories', ctrl.createCategory);
router.get('/summary', ctrl.summary);
router.get('/', ctrl.list);
router.post('/', validate(createExpenseSchema), ctrl.create);
router.get('/:id', ctrl.getById);
router.patch('/:id', validate(updateExpenseSchema), ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
