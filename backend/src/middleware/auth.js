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

  req.user = payload; // { id, role, storeId, name, tokenVersion }
  next();
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

module.exports = { authenticate, requireRole, requirePermission };
