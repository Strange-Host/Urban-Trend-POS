import type { RequestHandler } from 'express';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { canUser, type Permission } from './permissions.js';
import { authenticateToken, recentlyConfirmed, touch } from './sessions.js';

// While the screen is locked only these work: unlocking, signing out, and asking who is signed in. (Matched on the full path,
// because several routers share the /api prefix.)
const LOCKED_ALLOWLIST = new Set(['/api/auth/unlock', '/api/auth/logout', '/api/auth/me']);

/**
 * Sets req.user from the Authorization: Bearer header, or answers 401. Enforces the session's rules on every request:
 * an ended session is a 401, a locked one is a 403 SESSION_LOCKED, and a one-time password blocks everything but sign-out and
 * change-password. Only deliberate actions (a change, or the app's own "someone is here" ping) keep a session alive; reading
 * pages and background polling do not.
 */
export function requireAuth(pool: Pool, opts: { allowPasswordChange?: boolean } = {}): RequestHandler {
  return (req, _res, next) => {
    if (req.user) return next(); // several routers share the /api prefix; the person is looked up once per request
    const header = req.header('authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (!token) return next(new HttpError(401, 'NOT_LOGGED_IN', 'Log in to continue.'));
    authenticateToken(pool, token).then(async (r) => {
      if (r.kind === 'invalid') return next(new HttpError(401, 'SESSION_INVALID', 'Your session has ended. Log in again.'));
      if (r.kind === 'ended') return next(new HttpError(401, 'SESSION_EXPIRED', 'Your session has ended. Please sign in again.'));
      if (r.kind === 'token_expired') return next(new HttpError(401, 'TOKEN_EXPIRED', 'Your access has timed out. Refreshing it.'));
      const path = req.originalUrl.split('?')[0]!;
      if (r.standing === 'locked' && !LOCKED_ALLOWLIST.has(path)) return next(new HttpError(403, 'SESSION_LOCKED', 'The screen is locked. Enter your password or PIN to carry on.'));
      if (r.user.mustChangePassword && !opts.allowPasswordChange) {
        return next(new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your one-time password before doing anything else.'));
      }
      if (r.standing === 'active' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.header('x-background')) await touch(pool, r.session.id);
      req.user = r.user;
      req.sessionPolicy = r.policy;
      next();
    }).catch(next);
  };
}

/** Use after requireAuth. The role comes from the session, never from the request; the person's own overrides are applied. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'NOT_LOGGED_IN', 'Log in to continue.'));
    if (!canUser(req.user, permission)) return next(new HttpError(403, 'FORBIDDEN', 'You are not allowed to do this.'));
    next();
  };
}

/**
 * For risky actions: the person's own password (or a cashier's PIN) must have been typed within the last few minutes
 * (security_reauth_minutes). The app shows its "confirm it's you" box on REAUTH_REQUIRED and repeats the request by itself.
 * { writesOnly: true } guards a whole router but lets plain reads through.
 */
export function requireRecentAuth(opts: { writesOnly?: boolean } = {}): RequestHandler {
  return (req, _res, next) => {
    if (opts.writesOnly && ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!req.user || !req.sessionPolicy || !recentlyConfirmed(req.user, req.sessionPolicy)) {
      return next(new HttpError(403, 'REAUTH_REQUIRED', 'Please confirm it is you: enter your password (or PIN) to continue.'));
    }
    next();
  };
}
