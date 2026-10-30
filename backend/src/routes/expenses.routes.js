const router = require('express').Router();
const ctrl = require('../controllers/expenses.controller');
const { authenticate, requirePermission, requireAnyPermission } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { createExpenseSchema, updateExpenseSchema } = require('../validation/expenses.schema');

// Cashiers cannot record expenses — manager/admin only (§5.2 footnote). Deciding on them is its own permission
// ('expenses.approve'), so recording and approving can be given to different people.
router.use(authenticate);
const seeOrManage = requireAnyPermission('expenses.manage', 'expenses.approve');

router.get('/categories', seeOrManage, ctrl.listCategories);
router.post('/categories', requirePermission('expenses.manage'), ctrl.createCategory);
router.get('/summary', seeOrManage, ctrl.summary);
router.get('/', seeOrManage, ctrl.list);
router.post('/', requirePermission('expenses.manage'), validate(createExpenseSchema), ctrl.create);
router.get('/:id', seeOrManage, ctrl.getById);
router.patch('/:id', requirePermission('expenses.manage'), validate(updateExpenseSchema), ctrl.update);
router.post('/:id/approve', requirePermission('expenses.approve'), ctrl.approve);
router.post('/:id/reject', requirePermission('expenses.approve'), ctrl.reject);
router.delete('/:id', requirePermission('expenses.manage'), ctrl.remove);

module.exports = router;
