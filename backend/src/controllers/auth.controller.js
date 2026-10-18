const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const authTokens = require('../services/authTokens.service');
const twoFactor = require('../services/twoFactor.service');
const permissionsService = require('../services/permissions.service');
const sessionsService = require('../services/sessions.service');
const loginGuard = require('../services/loginGuard.service');
const { assertStrongPassword } = require('../utils/passwordPolicy');

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
// "Remember this device" decides the cookie's life: ticked = it survives closing the browser (until the session's
// own maximum); unticked = a browser-session cookie that is dropped when the browser closes. The server enforces
// the real limits either way (services/sessions.service.js), so this is the friendly half, not the only one.
function refreshCookieOptions(session) {
  const opts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth',
  };
  if (session && session.remember) {
    const left = sessionsService.parseTs(session.absolute_expires_at) - Date.now();
    opts.maxAge = Math.max(0, Math.min(REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000, left));
  }
  return opts;
}

// Short-lived on purpose — a leaked access token is only useful for a few
// minutes. Staying logged in beyond that goes through the refresh token
// (see authTokens.service.js), which is revocable and rotated on use.
function signAccessToken(user, session) {
  return jwt.sign(
    { id: user.id, role: user.role, storeId: user.store_id, name: user.name, tokenVersion: user.token_version, sid: session.id },
    process.env.JWT_SECRET,
    { expiresIn: process.env.ACCESS_TOKEN_EXPIRES_IN || '15m' }
  );
}

function toPublicUser(user) {
  const { password_hash, pin_code_hash, token_version, failed_login_count, locked_until, pin_failed_count, pin_locked_until, ...safe } = user;
  // The role defaults plus any per-user override — the UI uses this to decide
  // what to show; the SERVER re-checks on every request regardless.
  // has_pin: lets the lock screen offer the PIN keypad (only cashiers without sign-in codes may use a PIN to unlock).
  return { ...safe, has_pin: Boolean(pin_code_hash), permissions: permissionsService.effectiveKeys(user) };
}

function issueSession(user, req, res, { remember = false } = {}) {
  const session = sessionsService.create(user, { remember: remember === true, ip: req.ip, userAgent: req.get('user-agent') });
  const refreshToken = authTokens.issue(user.id, session.id);
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions(session));
  return { token: signAccessToken(user, session), user: toPublicUser(user), session: sessionsService.clientPolicy(user, session) };
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
  loginGuard.assertNotLocked(user, 'password');     // a locked account answers the same whether or not the password is right
  const passwordMatches = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passwordMatches) {
    loginGuard.recordFailure(user, 'password', { ip: req.ip });
    throw new ApiError(401, 'Invalid email or password.');
  }
  loginGuard.recordSuccess(user, 'password');

  // Accounts with sign-in codes switched on get a code by SMS and NO session
  // until it is verified (POST /api/auth/verify-otp).
  if (user.two_factor_enabled === 1) {
    return res.json(await twoFactor.start(user));
  }

  res.json(issueSession(user, req, res, { remember: req.body.remember === true }));
});

// POST /api/auth/verify-otp  { challengeToken, code, remember }
const verifyOtp = asyncHandler(async (req, res) => {
  const { challengeToken, code } = req.body;
  if (!challengeToken || !code) throw new ApiError(400, 'challengeToken and code are required.');
  const user = twoFactor.verify({ challengeToken, code });
  res.json(issueSession(user, req, res, { remember: req.body.remember === true }));
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
  loginGuard.assertNotLocked(user, 'pin');
  const pinMatches = bcrypt.compareSync(String(pin), user?.pin_code_hash || DUMMY_HASH);
  if (!user || !user.pin_code_hash || !pinMatches) {
    loginGuard.recordFailure(user, 'pin', { ip: req.ip });
    throw new ApiError(401, 'Invalid PIN.');
  }
  loginGuard.recordSuccess(user, 'pin');
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

  // A till is shared: a PIN sign-in is never "remembered".
  res.json(issueSession(user, req, res, { remember: false }));
});

// POST /api/auth/refresh
// Exchanges the refresh token cookie for a new short-lived access token,
// and rotates the refresh token itself (old one revoked, new one issued
// and re-set as the cookie). No request body — the cookie IS the input.
const refresh = asyncHandler(async (req, res) => {
  const { user, refreshToken, session } = authTokens.rotate(req.cookies[REFRESH_COOKIE_NAME], { ip: req.ip });
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions(session));
  res.json({ token: signAccessToken(user, session), user: toPublicUser(user), session: sessionsService.clientPolicy(user, session) });
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
  res.json({ user: toPublicUser(user), session: req.session ? sessionsService.clientPolicy(user, req.session) : null });
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
  if (newPassword === currentPassword) throw new ApiError(400, 'New password must be different from the current one.');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  loginGuard.assertNotLocked(user, 'password');
  if (!user || !bcrypt.compareSync(currentPassword, user.password_hash)) {
    loginGuard.recordFailure(user, 'password', { ip: req.ip });
    throw new ApiError(401, 'Current password is incorrect.');
  }
  assertStrongPassword(newPassword, { role: user.role, email: user.email, name: user.name, phone: user.phone });

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare(`
    UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1,
      password_changed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(newHash, user.id);

  authTokens.revokeAllForUser(user.id);               // every device signs in again with the new password
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
  res.status(200).json({ message: 'Password changed. Please log in again.' });
});

// ---- Confirming it's you: unlocking the screen, and the "confirm" step before risky actions ----------------------
// POST /api/auth/unlock  { password } or { pin }   (cashiers may use their PIN, everyone else their password)
// Wrong attempts count towards the same lockout as signing in.
const confirmIdentity = asyncHandler(async (req, res) => {
  const { password, pin } = req.body || {};
  if (!password && !pin) throw new ApiError(400, 'Enter your password or PIN.');
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(req.user.id);
  if (!user) throw new ApiError(401, 'Invalid or expired token.');

  if (pin && !password) {
    if (user.role !== 'cashier' || !user.pin_code_hash || user.two_factor_enabled === 1) {
      throw new ApiError(403, 'Use your password to continue.', null, 'PIN_NOT_ALLOWED');
    }
    loginGuard.assertNotLocked(user, 'pin');
    if (!bcrypt.compareSync(String(pin), user.pin_code_hash)) {
      const r = loginGuard.recordFailure(user, 'pin', { ip: req.ip });
      throw new ApiError(401, r.locked ? 'Too many wrong PINs. It is locked for a while.' : 'Incorrect PIN.');
    }
    loginGuard.recordSuccess(user, 'pin');
  } else {
    loginGuard.assertNotLocked(user, 'password');
    if (!bcrypt.compareSync(String(password), user.password_hash)) {
      const r = loginGuard.recordFailure(user, 'password', { ip: req.ip });
      throw new ApiError(401, r.locked ? 'Too many wrong passwords. It is locked for a while.' : 'Incorrect password.');
    }
    loginGuard.recordSuccess(user, 'password');
  }

  const session = sessionsService.confirm(req.session.id);
  res.json({ ok: true, session: sessionsService.clientPolicy(user, session) });
});

// POST /api/auth/activity - the app calls this (at most about once a minute) while a person is really using it.
// The sign-in session's idle clock is reset by real actions only; this covers reading and scrolling.
const activity = asyncHandler(async (req, res) => {
  res.json({ ok: true });                      // authenticate has already counted it (POST + not marked background)
});

// ---- Signed-in devices ---------------------------------------------------------------------------------------------
// GET /api/auth/sessions
const listSessions = asyncHandler(async (req, res) => {
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.user.id);
  res.json({ sessions: sessionsService.listForUser(user, req.session.id) });
});

// DELETE /api/auth/sessions/:id  (your own only; ending the current one is the same as signing out)
const endSession = asyncHandler(async (req, res) => {
  const target = sessionsService.get(Number(req.params.id));
  if (!target || target.user_id !== req.user.id) throw new ApiError(404, 'Device not found.');
  sessionsService.revoke(target.id, 'signed_out_by_user');
  if (target.id === req.session.id) res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/auth' });
  res.json({ ok: true, current: target.id === req.session.id });
});

// POST /api/auth/sessions/revoke-others - "sign out everywhere else"
const endOtherSessions = asyncHandler(async (req, res) => {
  const ended = sessionsService.revokeAllForUser(req.user.id, { exceptSessionId: req.session.id, reason: 'signed_out_everywhere' });
  res.json({ ok: true, ended });
});

module.exports = { login, verifyOtp, resendOtp, pinLogin, refresh, logout, me, changePassword, confirmIdentity, activity, listSessions, endSession, endOtherSessions, refreshCookieOptions, toPublicUser };
