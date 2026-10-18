const jwt = require('jsonwebtoken');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new ApiError(401, 'Missing or malformed Authorization header.');
  }
  const token = header.split(' ')[1];
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    throw new ApiError(401, 'Invalid or expired token.');
  }

  // A JWT alone stays valid until it naturally expires (up to JWT_EXPIRES_IN,
  // 8h by default) even after a password reset or account deactivation —
  // there's no other server-side way to revoke it early. token_version closes
  // that gap cheaply: it's bumped whenever a user's password changes or their
  // account is deactivated (see users.controller.js), so a stale token stops
  // working on its very next request instead of at expiry. One extra
  // synchronous, indexed lookup per request — better-sqlite3 makes this cheap
  // enough not to worry about at this app's scale.
  const current = db.prepare('SELECT token_version, is_active, must_change_password FROM users WHERE id = ?').get(payload.id);
  if (!current || current.is_active !== 1 || current.token_version !== payload.tokenVersion) {
    throw new ApiError(401, 'Invalid or expired token.');
  }

  // 2.1 — a one-time/temporary password (seeded admin, or any account an
  // admin resets in the future) shouldn't be enough to actually operate
  // the account, only to set a real password. req.originalUrl (not
  // req.path) is used deliberately: this middleware is shared across
  // every route file, each mounted at a different prefix, and only
  // originalUrl reliably reflects the full request path regardless of
  // which router invoked it.
  const CHANGE_PASSWORD_ALLOWLIST = ['/api/auth/change-password', '/api/auth/logout', '/api/auth/me'];
  if (current.must_change_password === 1 && !CHANGE_PASSWORD_ALLOWLIST.includes(req.originalUrl.split('?')[0])) {
    throw new ApiError(403, 'You must change your password before doing anything else.', null, 'PASSWORD_CHANGE_REQUIRED');
  }

  // Sign-in sessions (services/sessions.service.js): every access token names the session it belongs to, and that
  // session can end (idle too long, past its maximum, signed out elsewhere) or be locked. Checked on every request so
  // a copied token can't outlive the rules; locking is enforced here, not just drawn on screen.
  const sessions = require('../services/sessions.service');
  const session = payload.sid ? sessions.get(payload.sid) : null;
  if (!session || session.user_id !== payload.id) {
    throw new ApiError(401, 'Invalid or expired token.', null, 'SESSION_EXPIRED');
  }
  const standing = sessions.evaluate(session, payload.role);
  if (standing.state === 'revoked' || standing.state === 'expired') {
    throw new ApiError(401, 'Your session has ended. Please sign in again.', null, 'SESSION_EXPIRED');
  }
  const path = req.originalUrl.split('?')[0];
  if (standing.state === 'locked' && !LOCKED_ALLOWLIST.includes(path)) {
    throw new ApiError(403, 'The screen is locked. Enter your password or PIN to carry on.', null, 'SESSION_LOCKED');
  }
  // Only deliberate actions keep a session alive: any change (POST/PUT/PATCH/DELETE) or the app's own "someone is
  // using this" ping. Reading pages and background polling (the notification bell) deliberately do not.
  if (standing.state === 'active' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.headers['x-background']) {
    sessions.touch(session);
  }

  req.user = payload; // { id, role, storeId, name, tokenVersion, sid }
  req.session = session;
  next();
}

// While locked, only these work: unlocking, signing out, and asking who is signed in.
const LOCKED_ALLOWLIST = ['/api/auth/unlock', '/api/auth/logout', '/api/auth/me'];

// Usage: router.post('/:id/void', requireRecentAuth(), ...) - risky actions need the password (or a cashier's PIN)
// typed within the last few minutes (Security settings). The app shows a "confirm it's you" box and retries by itself.
// { writesOnly: true } guards a whole router but lets plain reads through.
function requireRecentAuth({ writesOnly = false } = {}) {
  return (req, res, next) => {
    if (writesOnly && ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const sessions = require('../services/sessions.service');
    if (!req.session || !sessions.recentlyConfirmed(req.session, req.user.role)) {
      throw new ApiError(403, 'Please confirm it is you: enter your password (or PIN) to continue.', null, 'REAUTH_REQUIRED');
    }
    next();
  };
}

// Usage: requireRole('admin', 'manager')
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw new ApiError(403, `Requires one of roles: ${roles.join(', ')}.`);
    }
    next();
  };
}

// Usage: requirePermission('reports.view') — see config/permissions.js. The
// role default reproduces the old requireRole lists exactly; an admin-set
// per-user override can widen or narrow it. Admin always passes.
function requirePermission(key) {
  return (req, res, next) => {
    // required lazily: permissions.service pulls in db/audit, which this
    // module shouldn't load at import time (keeps middleware/auth.js cheap to require)
    const permissionsService = require('../services/permissions.service');
    if (!req.user || !permissionsService.can(req.user, key)) {
      throw new ApiError(403, 'You do not have permission to do that.', null, 'FORBIDDEN');
    }
    next();
  };
}

module.exports = { authenticate, requireRole, requirePermission, requireRecentAuth };
