import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { permissionsOf } from '../auth/permissions.js';
import { changeOwnPassword, getUser, login, logout } from '../auth/service.js';
import type { Pool } from '../db/pool.js';
import { handler, parse } from '../http.js';
import { HttpError } from '../errors.js';

const loginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) });
const changeBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) });

export function authRouter(pool: Pool, opts: { sessionHours: number }): Router {
  const r = Router();
  r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }); // tokens and one-time passwords must never be cached

  r.post('/login', handler(async (req, res) => {
    const b = parse(loginBody, req.body);
    const out = await login(pool, { ...b, sessionHours: opts.sessionHours });
    res.json({ token: out.token, expiresAt: out.expiresAt, user: out.user, permissions: permissionsOf(out.user.role) });
  }));

  r.get('/me', requireAuth(pool, { allowPasswordChange: true }), handler(async (req, res) => {
    const user = await getUser(pool, req.user!.id);
    if (!user) throw new HttpError(401, 'SESSION_INVALID', 'Your session has ended. Log in again.');
    res.json({ user, permissions: permissionsOf(user.role) });
  }));

  r.post('/logout', requireAuth(pool, { allowPasswordChange: true }), handler(async (req, res) => {
    await logout(pool, req.user!);
    res.json({ ok: true });
  }));

  r.post('/change-password', requireAuth(pool, { allowPasswordChange: true }), handler(async (req, res) => {
    await changeOwnPassword(pool, req.user!, parse(changeBody, req.body));
    res.json({ ok: true });
  }));

  return r;
}
