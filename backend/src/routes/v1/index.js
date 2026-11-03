const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const validate = require('../../middleware/validate');
const { authenticate } = require('../../middleware/auth');
const { RATE_LIMITS } = require('../../config/limits');
const SqliteRateLimitStore = require('../../utils/sqliteRateLimitStore');
const mobileAuth = require('../../controllers/mobileAuth.controller');
const devices = require('../../controllers/devices.controller');
const home = require('../../controllers/home.controller');
const appVersion = require('../../controllers/appVersion.controller');
const schema = require('../../validation/mobile.schema');

// The mobile app's API, mounted at /api/v1 (app.js). The rule for this prefix: fields may be ADDED to responses and
// endpoints may be added, but nothing here is renamed or removed while an older app might still be installed - that
// is what keeps the app from needing an update every time the POS changes. A breaking change goes to /api/v2.

// Sign-in guesses share the web login's allowance (same scope), so an attacker gains nothing by switching doors.
const loginLimiter = rateLimit({
  ...RATE_LIMITS.LOGIN, standardHeaders: true,
  store: new SqliteRateLimitStore({ scope: 'login' }), passOnStoreError: true,
});

router.post('/auth/mobile/login', loginLimiter, validate(schema.mobileLogin), mobileAuth.login);
router.post('/auth/mobile/verify-otp', loginLimiter, validate(schema.mobileVerifyOtp), mobileAuth.verifyOtp);
router.post('/auth/mobile/refresh', validate(schema.refreshBody), mobileAuth.refresh);
router.post('/auth/mobile/logout', validate(schema.refreshBody), mobileAuth.logout);

// Public: the app asks this before anyone is signed in (and an app too old to sign in must still be able to read it).
router.get('/app/version', appVersion.get);

router.get('/home/attention', authenticate, home.attention);
router.get('/home/summary', authenticate, home.summary);

router.post('/devices', authenticate, validate(schema.registerDevice), devices.register);
router.get('/devices', authenticate, devices.list);
router.delete('/devices/:id', authenticate, devices.revoke);

module.exports = router;
