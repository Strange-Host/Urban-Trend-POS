const router = require('express').Router();
const ctrl = require('../controllers/endOfDay.controller');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);
router.get('/', requirePermission('attendance.review'), ctrl.get);
router.post('/approve', requirePermission('attendance.review'), ctrl.approve);

module.exports = router;
