import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import { ROLES } from '../auth/permissions.js';
import { createUser, listUsers, resetPassword, updateUser } from '../auth/service.js';
import type { Pool } from '../db/pool.js';
import { handler, idParam, parse } from '../http.js';

const role = z.enum(ROLES as [string, ...string[]]);
const createBody = z.object({ username: z.string().min(1).max(64), displayName: z.string().min(1).max(100), role });
const updateBody = z.object({ displayName: z.string().min(1).max(100).optional(), role: role.optional(), active: z.boolean().optional() })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change.');

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

  return r;
}
