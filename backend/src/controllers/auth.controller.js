const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const authTokens = require('../services/authTokens.service');
const twoFactor = require('../services/twoFactor.service');
const permissionsService = require('../services/permissions.service');

const REFRESH_COOKIE_NAME = 'ut_refresh_token';
const REFRESH_TOKEN_EXPIRES_DAYS = Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS) || 30;

// httpOnly: JS on the page can never read this, even via XSS — the only
// way to exfiltrate it would be a vulnerability that lets an attacker read
// raw HTTP response headers, a much higher bar than "reads localStorage".
// SameSite=Strict: the browser will never attach this cookie to a
// cross-site request, which is also exactly what CSRF protection needs —
// the only requests that ever carry it are ones the user's own browser
// makes to this same site. Secure is conditional on NODE_ENV: a real
// deployment is HTTPS and should require it; localhost dev over plain
// HTTP would silently never send a `Secure` cookie at all.
// path scoped to /api/auth — this cookie has no reason to be sent on any
// other request, so it isn't.
function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000,
  };
}

// Short-lived on purpose — a leaked access token is only useful for a few
// minutes. Staying logged in beyond that goes through the refresh token
// (see authTokens.service.js), which is revocable and rotated on use.
function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, storeId: user.store_id, name: user.name, tokenVersion: user.token_version },
    process.env.JWT_SECRET,
    { expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m' }
  );
}

function toPublicUser(user) {
  const { password_hash, pin_code_hash, token_version, ...safe } = user;
  // The role defaults plus any per-user override — the UI uses this to decide
  // what to show; the SERVER re-checks on every request regardless.
  return { ...safe, permissions: permissionsService.effectiveKeys(user) };
}

function issueSession(user, res) {
  const refreshToken = authTokens.issue(user.id);
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  return { token: signAccessToken(user), user: toPublicUser(user) };
}

// 2.2 — a precomputed hash of a value nobody will ever type, used so the
// bcrypt comparison always runs (and always takes the same ~bcrypt-cost
// amount of time) whether or not the email/userId actually exists. Without
// this, `!user || ...` short-circuits before ever calling bcrypt for a
// nonexistent account, and a nonexistent-account response returns
// measurably faster than a wrong-password one — enough of a timing
// difference to enumerate which emails/PINs have real accounts, without
// ever needing a correct password. Computed once at module load, not per
// request — bcrypt hashing is deliberately slow, so doing it on every
// request here (rather than once, ever) would turn this fix into its own
// denial-of-service surface.
const DUMMY_HASH = bcrypt.hashSync('this-is-not-a-real-password-just-for-constant-time-compares', 10);

// POST /api/auth/login  { email, password }
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw new ApiError(400, 'Email and password are required.');

  const user = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND is_active = 1').get(email.trim());
  const passwordMatches = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordMatches) {
    throw new ApiError(401, 'Invalid email or password.');
  }

  // Accounts with sign-in codes switched on get a code by SMS and NO session
  // until it is verified (POST /api/auth/verify-otp).
  if (user.two_factor_enabled === 1) {
    return res.json(await twoFactor.start(user));
  }

  res.json(issueSession(user, res));
});

// POST /api/auth/verify-otp  { challengeToken, code }
const verifyOtp = asyncHandler(async (req, res) => {
  const { challengeToken, code } = req.body;
  if (!challengeToken || !code) throw new ApiError(400, 'challengeToken and code are required.');
  const user = twoFactor.verify({ challengeToken, code });
  res.json(issueSession(user, res));
});

// POST /api/auth/resend-otp  { challengeToken }
const resendOtp = asyncHandler(async (req, res) => {
  if (!req.body.challengeToken) throw new ApiError(400, 'challengeToken is required.');
  res.json(await twoFactor.resend({ challengeToken: req.body.challengeToken }));
});

// POST /api/auth/pin-login  { userId, pin }
// Fast login at a shared register terminal.
const pinLogin = asyncHandler(async (req, res) => {
  const { userId, pin } = req.body;
  if (!userId || !pin) throw new ApiError(400, 'userId and pin are required.');

  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(userId);
  const pinMatches = bcrypt.compareSync(pin, user?.pin_code_hash || DUMMY_HASH);
  if (!user || !user.pin_code_hash || !pinMatches) {
    throw new ApiError(401, 'Invalid PIN.');
  }
  // A PIN is a four-digit shortcut for a shared till. An account protected by
  // sign-in codes has chosen the opposite trade-off, so it can't use one.
  if (user.two_factor_enabled === 1) {
    throw new ApiError(403, 'This account requires full sign-in (email, password and a code). PIN login is not available.', null, 'PIN_LOGIN_DISABLED');
  }

  // A four-digit PIN is a till shortcut for cashiers. It never signs in an admin or
  // manager (they have money, staff and settings access) - those use email + password.
  if (user.role !== 'cashier') {
    throw new ApiError(403, 'PIN login is only available to cashier accounts. Sign in with your email and password.', null, 'PIN_LOGIN_CASHIERS_ONLY');
  }

  res.json(issueSession(user, res));
});

// POST /api/auth/refresh
// Exchanges the refresh token cookie for a new short-lived access token,
// and rotates the refresh token itself (old one revoked, new one issued
// and re-set as the cookie). No request body — the cookie IS the input.
const refresh = asyncHandler(async (req, res) => {
  const { user, refreshToken } = authTokens.rotate(req.cookies[REFRESH_COOKIE_NAME]);
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  res.json({ token: signAccessToken(user), user: toPublicUser(user) });
});

// POST /api/auth/logout
const logout = asyncHandler(async (req, res) => {
  authTokens.revoke(req.cookies[REFRESH_COOKIE_NAME]);
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
  res.status(204).send();
});

// GET /api/auth/me
const me = asyncHandler(async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) throw new ApiError(404, 'User not found.');
  res.json({ user: toPublicUser(user) });
});

// POST /api/auth/change-password  { currentPassword, newPassword }
// The only way out of must_change_password = 1 (see middleware/auth.js for
// the enforcement) — also usable any time by choice, not just when forced.
// Bumps token_version and revokes the current refresh token so the OLD
// (possibly leaked/shared, e.g. a one-time seeded password) session can't
// keep being used after this — the person has to actually sign back in
// with the new password, on this device same as any other.
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) throw new ApiError(400, 'currentPassword and newPassword are required.');
  if (newPassword.length < 8) throw new ApiError(400, 'newPassword must be at least 8 characters.');
  if (newPassword === currentPassword) throw new ApiError(400, 'New password must be different from the current one.');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    throw new ApiError(401, 'Current password is incorrect.');
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare(`
    UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(newHash, user.id);

  authTokens.revoke(req.cookies[REFRESH_COOKIE_NAME]);
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
  res.status(200).json({ message: 'Password changed. Please log in again.' });
});

module.exports = { login, verifyOtp, resendOtp, pinLogin, refresh, logout, me, changePassword };
