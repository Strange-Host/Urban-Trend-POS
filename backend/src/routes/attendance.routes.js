const router = require('express').Router();
const ctrl = require('../controllers/attendance.controller');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

// Any authenticated staff member can clock themselves in/out.
router.post('/clock-in', ctrl.clockIn);
router.post('/clock-out', ctrl.clockOut);

// Store-wide visibility is a management concern.
router.get('/today', requirePermission('attendance.view'), ctrl.listForDate);
router.get('/absences-today', requirePermission('attendance.view'), ctrl.absencesToday);

module.exports = router;
