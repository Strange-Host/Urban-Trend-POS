const router = require('express').Router();
const ctrl = require('../controllers/staffLogs.controller');
const { authenticate, requireRole } = require('../middleware/auth');

// "View Staff Logs" is admin-only per the role matrix (§5.2).
router.use(authenticate, requireRole('admin'));

router.get('/stats', ctrl.stats);
router.get('/', ctrl.list);

module.exports = router;
