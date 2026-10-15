const router = require('express').Router();
const ctrl = require('../controllers/telesales.controller');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate, requireRole('admin'));

router.post('/rebalance', ctrl.rebalance);

module.exports = router;
