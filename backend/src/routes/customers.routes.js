const router = require('express').Router();
const ctrl = require('../controllers/customers.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// Same audience as the orders screen: whoever can work an order can see that customer's history.
router.use(authenticate, requireRole('admin', 'manager', 'cashier'));

// Static path first so "orders" is never read as an :id.
router.get('/orders', ctrl.history);
router.get('/:id/orders', ctrl.history);

module.exports = router;
