import { Router } from 'express';
import { z } from 'zod';
import { describeForUser, setOverrides } from '../auth/access.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { ROLES } from '../auth/permissions.js';
import { createUser, getUser, listUsers, resetPassword, setPin, signOutEverywhere, unlockAccount, updateUser } from '../auth/service.js';
import { listSessions } from '../auth/sessions.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { handler, idParam, parse } from '../http.js';

const role = z.enum(ROLES as [string, ...string[]]);
const email = z.string().max(254).nullable();
const phone = z.string().max(30).nullable();
const createBody = z.object({ username: z.string().min(1).max(64), displayName: z.string().min(1).max(100), role, email: email.optional(), phone: phone.optional(), pin: z.string().max(12).optional() });
const updateBody = z.object({ displayName: z.string().min(1).max(100).optional(), role: role.optional(), active: z.boolean().optional(), email: email.optional(), phone: phone.optional() })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change.');
const pinBody = z.object({ pin: z.string().max(12).nullable() });
const permissionsBody = z.object({ overrides: z.record(z.string(), z.boolean().nullable()) });

export function usersRouter(pool: Pool): Router {
  const r = Router();
  r.use(requireAuth(pool), requirePermission('users.manage'));
  r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  r.get('/', handler(async (_req, res) => { res.json({ users: await listUsers(pool) }); }));

  r.post('/', handler(async (req, res) => {
    const b = parse(createBody, req.body);
    const out = await createUser(pool, { ...b, role: b.role as 'admin' | 'manager' | 'cashier', actor: req.user!.username, actorRole: req.user!.role });
    res.status(201).json(out); // the one-time password appears here, once
  }));

  r.patch('/:id', handler(async (req, res) => {
    const b = parse(updateBody, req.body);
    res.json({ user: await updateUser(pool, { userId: idParam(req.params.id), ...b, role: b.role as 'admin' | 'manager' | 'cashier' | undefined, actor: req.user! }) });
  }));

  r.post('/:id/reset-password', handler(async (req, res) => {
    res.json(await resetPassword(pool, { userId: idParam(req.params.id), actor: req.user! }));
  }));

  // A register PIN: set, change, or (null) remove. 4 to 6 digits and not an obvious one.
  r.put('/:id/pin', handler(async (req, res) => {
    res.json({ user: await setPin(pool, { userId: idParam(req.params.id), pin: parse(pinBody, req.body).pin, actor: req.user! }) });
  }));

  // Lifts a wrong-password or wrong-PIN lockout right now.
  r.post('/:id/unlock-account', handler(async (req, res) => {
    res.json({ user: await unlockAccount(pool, { userId: idParam(req.params.id), actor: req.user! }) });
  }));

  r.post('/:id/sign-out-everywhere', handler(async (req, res) => {
    res.json({ ok: true, ended: await signOutEverywhere(pool, { userId: idParam(req.params.id), actor: req.user! }) });
  }));

  // The signed-in devices of one person (an admin looking at someone else's).
  r.get('/:id/sessions', handler(async (req, res) => {
    const u = await getUser(pool, idParam(req.params.id));
    if (!u) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');
    res.json({ sessions: await listSessions(pool, u, null) });
  }));

  // "Staff access": the editor's view of one person's permissions, and a change to them.
  r.get('/:id/permissions', handler(async (req, res) => { res.json(await describeForUser(pool, idParam(req.params.id))); }));
  r.put('/:id/permissions', handler(async (req, res) => {
    res.json(await setOverrides(pool, { userId: idParam(req.params.id), overrides: parse(permissionsBody, req.body).overrides, actor: req.user! }));
  }));

  return r;
}
