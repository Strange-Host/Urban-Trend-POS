const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { login, verifyOtp, resendOtp, pinLogin, refresh, logout, me, changePassword } = require('../controllers/auth.controller');
const { RATE_LIMITS } = require('../config/limits');
const { authenticate } = require('../middleware/auth');

// Brute-force protection belongs on the endpoints an attacker can actually
// guess their way into (password, PIN) — refresh/logout require already
// possessing an unguessable 80-byte token, so rate-limiting those as
// tightly only hurts a shop with several registers sharing one IP each
// refreshing their short-lived access token periodically.
const loginLimiter = rateLimit({ ...RATE_LIMITS.LOGIN, standardHeaders: true });

router.post('/login', loginLimiter, login);
router.post('/verify-otp', loginLimiter, verifyOtp);
router.post('/resend-otp', loginLimiter, resendOtp);
router.post('/pin-login', loginLimiter, pinLogin);
router.post('/refresh', refresh);
router.post('/logout', logout);
router.get('/me', authenticate, me);
// Reachable even while must_change_password blocks everything else (see
// middleware/auth.js's allowlist) — this is the one authenticated route
// that HAS to stay open, since it's the only way out of that state.
router.post('/change-password', authenticate, changePassword);

module.exports = router;
