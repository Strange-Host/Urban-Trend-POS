const router = require('express').Router();
const ctrl = require('../controllers/custody.controller');
const { authenticate, requirePermission } = require('../middleware/auth');

// Shop cash held by staff until it is deposited. Taking the cash is POST /api/orders/:id/shop-cash; closing
// it out here is a manager/admin action, so the person holding the cash is not the one who signs it off.
router.use(authenticate);
router.get('/', requirePermission('custody.manage'), ctrl.list);
router.post('/:id/deposit', requirePermission('custody.manage'), ctrl.deposit);

module.exports = router;
