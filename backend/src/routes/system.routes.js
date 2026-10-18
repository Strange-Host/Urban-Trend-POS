const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { RATE_LIMITS } = require('../config/limits');
const ctrl = require('../controllers/system.controller');
const { authenticate, requireRole, requireRecentAuth } = require('../middleware/auth');
const alertOnChange = require('../middleware/alertOnChange');

// Server-level settings: admin only, like the rest of Settings. Never delegable.
router.use(authenticate, requireRole('admin'));

const outboundLimiter = rateLimit({ ...RATE_LIMITS.SYNC, standardHeaders: true }); // both checks reach out to the internet

router.get('/config', ctrl.getConfig);
router.put('/config', requireRecentAuth(), alertOnChange('Server, email or backup settings'), ctrl.saveConfig);
router.post('/test-email', outboundLimiter, ctrl.testEmail);
router.post('/check-public-url', outboundLimiter, ctrl.checkPublicUrl);

module.exports = router;
