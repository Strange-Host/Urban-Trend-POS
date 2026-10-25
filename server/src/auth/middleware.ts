import type { RequestHandler } from 'express';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { can, type Permission } from './permissions.js';
import { authenticateToken } from './service.js';

/** Sets req.user from the Authorization: Bearer header, or answers 401. Rejects everything but sign-out and change-password while a one-time password is still in use. */
export function requireAuth(pool: Pool, opts: { allowPasswordChange?: boolean } = {}): RequestHandler {
  return (req, _res, next) => {
    if (req.user) return next(); // several routers share the /api prefix; the person is looked up once per request
    const header = req.header('authorization') ?? '';
    const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
    if (!token) return next(new HttpError(401, 'NOT_LOGGED_IN', 'Log in to continue.'));
    authenticateToken(pool, token).then((user) => {
      if (!user) return next(new HttpError(401, 'SESSION_INVALID', 'Your session has ended. Log in again.'));
      if (user.mustChangePassword && !opts.allowPasswordChange) {
        return next(new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your one-time password before doing anything else.'));
      }
      req.user = user;
      next();
    }).catch(next);
  };
}

/** Use after requireAuth. The role comes from the session, never from the request. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(new HttpError(401, 'NOT_LOGGED_IN', 'Log in to continue.'));
    if (!can(req.user.role, permission)) return next(new HttpError(403, 'FORBIDDEN', 'Your role is not allowed to do this.'));
    next();
  };
}
