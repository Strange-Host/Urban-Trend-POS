import type { Request, Response } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import { effectiveEditorKeys, overridesFor } from '../auth/access.js';
import { clearRefreshCookie, readCookie, REFRESH_COOKIE, setRefreshCookie } from '../auth/cookies.js';
import { requireAuth } from '../auth/middleware.js';
import { permissionsOfUser } from '../auth/permissions.js';
import { changeOwnPassword, confirmIdentity, getUser, login, loginWithPin, logout, type UserView } from '../auth/service.js';
import { authenticateToken, clientPolicy, confirmSession, endAllSessions, endSession, endSessionByRefresh, getSession, listSessions, refreshSession, type SessionRow } from '../auth/sessions.js';
import type { SessionPolicy } from '../auth/settings.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { audit } from '../pos/audit.js';
import { handler, idParam, parse } from '../http.js';

const loginBody = z.object({
  username: z.string().min(1).max(254).optional(),
  email: z.string().min(1).max(254).optional(),
  password: z.string().min(1).max(200),
  remember: z.boolean().optional(),
}).refine((b) => Boolean(b.username || b.email), { message: 'Enter your email or username.', path: ['username'] });
const pinBody = z.object({ userId: z.coerce.number().int().positive(), pin: z.string().min(1).max(12) });
const changeBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) });
const unlockBody = z.object({ password: z.string().min(1).max(200).optional(), pin: z.string().min(1).max(12).optional() })
  .refine((b) => b.password !== undefined || b.pin !== undefined, 'Enter your password or PIN.');

export interface AuthRouterOptions {
  /** SESSION_HOURS: how long a session that is not "remembered" may last, unless the security settings say otherwise. */
  sessionHours: number;
  /** Mark the refresh cookie Secure. True on a real (HTTPS) deployment; false on plain-HTTP localhost, which would drop it. */
  secureCookies?: boolean;
  accessMinutes?: number;
  refreshDays?: number;
}

export function authRouter(pool: Pool, opts: AuthRouterOptions): Router {
  const r = Router();
  const secure = opts.secureCookies === true;
  const sessionOpts = { accessMinutes: opts.accessMinutes, refreshDays: opts.refreshDays, unrememberedHours: opts.sessionHours };
  r.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }); // tokens and one-time passwords must never be cached

  /** Who the person is and what they may do: `permissions` are the engine's, `uiPermissions` the Staff access keys the screens ask about. */
  async function identity(user: UserView) {
    const overrides = await overridesFor(pool, user.id);
    return { user, permissions: permissionsOfUser({ role: user.role, overrides }), uiPermissions: await effectiveEditorKeys(pool, user) };
  }
  /** What every sign-in and refresh answers with. `token` is the short-lived access token; the refresh token is only ever a cookie. */
  async function signedIn(res: Response, user: UserView, tokens: { accessToken: string; refreshToken: string; session: SessionRow; policy: SessionPolicy }) {
    setRefreshCookie(res, tokens.refreshToken, { secure, remember: tokens.session.remember, expiresAt: tokens.session.expires_at });
    return {
      token: tokens.accessToken, expiresAt: tokens.session.expires_at, accessExpiresAt: tokens.session.access_expires_at,
      ...(await identity(user)), session: clientPolicy(tokens.session, tokens.policy),
    };
  }
  const meta = (req: Request) => ({ ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null });

  r.post('/login', handler(async (req, res) => {
    const b = parse(loginBody, req.body);
    const opened = await login(pool, { username: (b.username ?? b.email)!, password: b.password, remember: b.remember === true, ...meta(req), ...sessionOpts });
    res.json(await signedIn(res, opened.user, opened));
  }));

  // Fast sign-in at a shared register. Cashiers only; never remembered.
  r.post('/pin-login', handler(async (req, res) => {
    const b = parse(pinBody, req.body);
    const opened = await loginWithPin(pool, { userId: b.userId, pin: b.pin, ...meta(req), ...sessionOpts });
    res.json(await signedIn(res, opened.user, opened));
  }));

  // No body: the refresh cookie IS the input. Swaps it for a new one and hands back a new short-lived access token.
  r.post('/refresh', handler(async (req, res) => {
    try {
      const out = await refreshSession(pool, readCookie(req, REFRESH_COOKIE), {
        ...sessionOpts,
        onReuse: async (userId) => {
          const u = await getUser(pool, userId);
          await audit(pool, { actor: u?.username ?? `user#${userId}`, role: u?.role, action: 'refresh_token_reuse', entityType: 'user', entityId: userId, risk: 2, details: { ip: req.ip ?? null } });
        },
      });
      const user = await getUser(pool, out.user.id);
      if (!user) throw new HttpError(401, 'REFRESH_INVALID', 'Invalid or expired refresh token.');
      res.json(await signedIn(res, user, out));
    } catch (err) {
      if (err instanceof HttpError && (err.code === 'REFRESH_INVALID' || err.code === 'SESSION_EXPIRED')) clearRefreshCookie(res, secure);
      throw err;
    }
  }));

  // Signing out must never fail: it ends the session behind the refresh cookie and the one behind the bearer token, if either is still good.
  r.post('/logout', handler(async (req, res) => {
    await endSessionByRefresh(pool, readCookie(req, REFRESH_COOKIE));
    const token = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '')?.[1];
    if (token) {
      const found = await authenticateToken(pool, token);
      if (found.kind === 'ok') await logout(pool, found.user);
    }
    clearRefreshCookie(res, secure);
    res.json({ ok: true });
  }));

  r.get('/me', requireAuth(pool, { allowPasswordChange: true }), handler(async (req, res) => {
    const user = await getUser(pool, req.user!.id);
    if (!user) throw new HttpError(401, 'SESSION_INVALID', 'Your session has ended. Log in again.');
    const s = await getSession(pool, req.user!.sessionId);
    res.json({ ...(await identity(user)), session: s ? clientPolicy(s, req.sessionPolicy!) : null });
  }));

  r.post('/change-password', requireAuth(pool, { allowPasswordChange: true }), handler(async (req, res) => {
    await changeOwnPassword(pool, req.user!, parse(changeBody, req.body));
    res.json({ ok: true });
  }));

  // Opens a locked screen, and is the "confirm it's you" step before a risky action.
  r.post('/unlock', requireAuth(pool), handler(async (req, res) => {
    await confirmIdentity(pool, req.user!, parse(unlockBody, req.body));
    await confirmSession(pool, req.user!.sessionId);
    const s = await getSession(pool, req.user!.sessionId);
    res.json({ ok: true, session: s ? clientPolicy(s, req.sessionPolicy!) : null });
  }));

  // The app calls this (at most about once a minute) while a person is really using it. requireAuth has already counted it:
  // it is a POST and not marked as background. It covers reading and scrolling, which otherwise would not keep a session alive.
  r.post('/activity', requireAuth(pool), handler(async (_req, res) => { res.json({ ok: true }); }));

  // Signed-in devices.
  r.get('/sessions', requireAuth(pool), handler(async (req, res) => {
    res.json({ sessions: await listSessions(pool, req.user!, req.user!.sessionId) });
  }));
  r.post('/sessions/revoke-others', requireAuth(pool), handler(async (req, res) => {
    const ended = await endAllSessions(pool, req.user!.id, { exceptSessionId: req.user!.sessionId, reason: 'signed_out_everywhere' });
    await audit(pool, { actor: req.user!.username, role: req.user!.role, action: 'signed_out_other_devices', entityType: 'user', entityId: req.user!.id, risk: 1, details: { ended } });
    res.json({ ok: true, ended });
  }));
  // Your own only. Ending the current one is the same as signing out.
  r.delete('/sessions/:id', requireAuth(pool), handler(async (req, res) => {
    const id = idParam(req.params.id);
    const target = await getSession(pool, id);
    if (!target || target.user_id !== req.user!.id || target.revoked_at) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Device not found.');
    await endSession(pool, id, 'signed_out_by_user');
    const current = id === req.user!.sessionId;
    if (current) clearRefreshCookie(res, secure);
    res.json({ ok: true, current });
  }));

  return r;
}
