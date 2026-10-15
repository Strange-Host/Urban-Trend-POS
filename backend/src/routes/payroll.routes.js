const router = require('express').Router();
const ctrl = require('../controllers/payroll.controller');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate, requirePermission('payroll.view'));

router.get('/summary', ctrl.getSummary);
router.post('/loss-deduction', ctrl.recordLossDeduction);

module.exports = router;
