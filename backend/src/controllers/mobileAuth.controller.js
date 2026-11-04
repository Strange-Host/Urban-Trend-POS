const bcrypt = require('bcryptjs');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const authTokens = require('../services/authTokens.service');
const twoFactor = require('../services/twoFactor.service');
const sessionsService = require('../services/sessions.service');
const loginGuard = require('../services/loginGuard.service');
const devices = require('../services/devices.service');
const { signAccessToken, toPublicUser } = require('./auth.controller');
const { appSettings } = require('./mobileApi.controller');

// Mobile sign-in. Same rules as the web login (account lockout, 2-step codes, rotation, replay detection,
// token_version revocation) - the only difference is the transport: the refresh token travels in the JSON body, because
// the app keeps it in the Android Keystore instead of a browser cookie. Everything here lands in the same
// auth_sessions / refresh_tokens tables, so "sign out everywhere", password changes and deactivation already cover phones.

// Same constant-time trick as the web login: bcrypt always runs, so an unknown email answers as slowly as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('this-is-not-a-real-password-just-for-constant-time-compares', 10);

function issueMobileSession(user, req, deviceInput) {
  const device = devices.describe(deviceInput);
  const known = devices.isKnownDevice(user.id, device.id);
  // A phone stays signed in (the session's hard maximum still applies); the app protects it with biometric unlock.
  const session = sessionsService.create(user, { remember: true, ip: req.ip, userAgent: req.get('user-agent'), client: 'mobile', device });
  const refreshToken = authTokens.issue(user.id, session.id);
  if (!known) devices.alertNewDevice({ user, device, ip: req.ip });
  return {
    token: signAccessToken(user, session), refreshToken, user: toPublicUser(user),
    session: { id: session.id, expiresAt: session.absolute_expires_at }, settings: appSettings(),
  };
}

// POST /api/v1/auth/mobile/login  { email, password, device? }
const login = asyncHandler(async (req, res) => {
  const { email, password, device } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND is_active = 1').get(email);
  loginGuard.assertNotLocked(user, 'password');
  const passwordMatches = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordMatches) {
    loginGuard.recordFailure(user, 'password', { ip: req.ip });
    throw new ApiError(401, 'Invalid email or password.');
  }
  loginGuard.recordSuccess(user, 'password');

  // Accounts with sign-in codes get a code by SMS and no session until it is verified.
  if (user.two_factor_enabled === 1) return res.json(await twoFactor.start(user));

  res.json(issueMobileSession(user, req, device));
});

// POST /api/v1/auth/mobile/verify-otp  { challengeToken, code, device? }
const verifyOtp = asyncHandler(async (req, res) => {
  const user = twoFactor.verify({ challengeToken: req.body.challengeToken, code: req.body.code });
  res.json(issueMobileSession(user, req, req.body.device));
});

// POST /api/v1/auth/mobile/refresh  { refreshToken }
// Rotates: the old token dies, a new one comes back in the body. A token that was already swapped and is presented again
// (after the short grace period) ends the whole session and alerts the owner, exactly as on the web.
const refresh = asyncHandler(async (req, res) => {
  const { user, refreshToken, session } = authTokens.rotate(req.body.refreshToken, { ip: req.ip, client: 'mobile' });
  res.json({
    token: signAccessToken(user, session), refreshToken, user: toPublicUser(user),
    session: { id: session.id, expiresAt: session.absolute_expires_at }, settings: appSettings(),
  });
});

// POST /api/v1/auth/mobile/logout  { refreshToken }
// Ends this phone's session. Always 204, even for an unknown token (signing out should never fail).
const logout = asyncHandler(async (req, res) => {
  authTokens.revoke(req.body.refreshToken);
  res.status(204).send();
});

module.exports = { login, verifyOtp, refresh, logout };
