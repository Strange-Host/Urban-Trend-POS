const router = require('express').Router();
const ctrl = require('../controllers/security.controller');
const { authenticate, requireRole, requireRecentAuth } = require('../middleware/auth');

// Admin only. Reading is free; changing the rules needs the password typed recently.
router.use(authenticate, requireRole('admin'));
router.get('/policy', ctrl.getPolicy);
router.put('/policy', requireRecentAuth(), ctrl.updatePolicy);
router.get('/events', ctrl.listEvents);

module.exports = router;
