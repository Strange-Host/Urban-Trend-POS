const router = require('express').Router();
const ctrl = require('../controllers/stores.controller');
const { authenticate, requireRole } = require('../middleware/auth');
const requireModule = require('../middleware/requireModule');

router.use(authenticate);

router.get('/', ctrl.list);
// Adding or editing branches is part of multi-branch mode. Listing stays open: screens use it to show the current branch name.
router.post('/', requireModule('branches'), requireRole('admin'), ctrl.create);
router.put('/:id', requireModule('branches'), requireRole('admin'), ctrl.update);

module.exports = router;
