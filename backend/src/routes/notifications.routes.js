const router = require('express').Router();
const ctrl = require('../controllers/notifications.controller');
const { authenticate } = require('../middleware/auth');

// Any signed-in user — every handler is scoped to req.user.id, so there is
// nothing role-specific to gate.
router.use(authenticate);

router.get('/', ctrl.list);
router.get('/unread-count', ctrl.unreadCount);
router.post('/read-all', ctrl.markAllRead);
router.post('/:id/read', ctrl.markRead);

module.exports = router;
