const router = require('express').Router();
const ctrl = require('../controllers/cashSessions.controller');
const { authenticate, requirePermission } = require('../middleware/auth');

router.use(authenticate);

// Any authenticated staff member can open/close their own session — a
// cashier working the register needs this same as an admin covering a
// shift. Viewing OTHER people's sessions (the list/detail views) is
// oversight and stays admin/manager, matching the rest of the financial
// reporting surface (Payments, reports).
router.get('/current', ctrl.current);
router.post('/open', ctrl.open);
router.post('/:id/close', ctrl.close);
router.get('/', requirePermission('cashsessions.view'), ctrl.list);
router.get('/:id', requirePermission('cashsessions.view'), ctrl.getById);

module.exports = router;
