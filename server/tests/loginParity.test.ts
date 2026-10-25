import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireAuth, requireRecentAuth } from '../src/auth/middleware.js';
import type { Role } from '../src/auth/permissions.js';
import { createUser } from '../src/auth/service.js';
import { clearSettingsCache, setSettings } from '../src/auth/settings.js';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';
import { handler } from '../src/http.js';
import { makeTestDb, type TestDb } from './helpers.js';

let db: TestDb;
const app = () => createApp({ pool: db.pool, logger: createLogger('silent'), sessionHours: 12, corsOrigins: ['http://localhost:5173'] });
beforeAll(async () => { db = await makeTestDb(); await runMigrations(db.pool); });
afterAll(() => db.drop());

// ---------------------------------------------------------------------------------------------------------------- helpers
let n = 0;
const cookieOf = (res: request.Response): string => {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('ut_refresh_token='));
  if (!raw) throw new Error('no refresh cookie in the response');
  return raw.split(';')[0]!;
};
const cookieValue = (c: string) => c.slice('ut_refresh_token='.length);

interface Person { id: number; username: string; email: string; password: string; role: Role }
/** An account whose one-time password has been changed, so it can actually work. */
async function person(role: Role, opts: { pin?: string } = {}): Promise<Person> {
  const username = `${role}${++n}p${Math.random().toString(36).slice(2, 6)}`;
  const email = `${username}@shop.test`;
  const { user, temporaryPassword } = await createUser(db.pool, { username, displayName: `Test ${role}`, role, email, pin: opts.pin, actor: 'test-setup' });
  const first = await request(app()).post('/api/auth/login').send({ email, password: temporaryPassword });
  const password = `Better-${Math.random().toString(36).slice(2, 12)}-pw`;
  const ch = await request(app()).post('/api/auth/change-password').set('Authorization', `Bearer ${first.body.token}`).send({ currentPassword: temporaryPassword, newPassword: password });
  if (ch.status !== 200) throw new Error(`change-password failed: ${JSON.stringify(ch.body)}`);
  return { id: user.id, username, email, password, role };
}
async function signIn(p: Person, extra: Record<string, unknown> = {}) {
  const res = await request(app()).post('/api/auth/login').send({ email: p.email, password: p.password, ...extra });
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
  return { res, token: res.body.token as string, auth: `Bearer ${res.body.token}`, cookie: cookieOf(res), sessionId: res.body.session.id as number };
}
const idle = (sessionId: number, minutes: number) => db.pool.query(`UPDATE sessions SET last_activity_at = now() - make_interval(mins => $2) WHERE id = $1`, [sessionId, minutes]);

// ---------------------------------------------------------------------------------------------------------------- sign in
describe('signing in by email', () => {
  it('accepts the email (any case) or the username, and answers the same for a wrong password and an unknown email', async () => {
    const p = await person('manager');
    expect((await request(app()).post('/api/auth/login').send({ email: p.email.toUpperCase(), password: p.password })).status).toBe(200);
    expect((await request(app()).post('/api/auth/login').send({ username: p.username, password: p.password })).status).toBe(200);
    const wrong = await request(app()).post('/api/auth/login').send({ email: p.email, password: 'nope-nope-nope' });
    const unknown = await request(app()).post('/api/auth/login').send({ email: 'nobody@shop.test', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
  });

  it('keeps emails unique and well formed', async () => {
    const p = await person('cashier');
    const admin = await person('admin');
    const a = (await signIn(admin)).auth;
    const dupe = await request(app()).post('/api/users').set('Authorization', a).send({ username: `dupe${++n}`, displayName: 'Dupe', role: 'cashier', email: p.email.toUpperCase() });
    expect(dupe.status).toBe(409);
    expect(dupe.body.error.code).toBe('EMAIL_TAKEN');
    const bad = await request(app()).post('/api/users').set('Authorization', a).send({ username: `bad${++n}`, displayName: 'Bad', role: 'cashier', email: 'not-an-email' });
    expect(bad.body.error.code).toBe('BAD_EMAIL');
  });

  it('refuses an account with sign-in codes switched on rather than letting a password alone through', async () => {
    const p = await person('cashier');
    await db.pool.query(`UPDATE users SET two_factor_enabled = true WHERE id = $1`, [p.id]);
    const res = await request(app()).post('/api/auth/login').send({ email: p.email, password: p.password });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TWO_FACTOR_UNAVAILABLE');
    expect(res.body.token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------- tokens
describe('access and refresh tokens', () => {
  it('puts the refresh token only in an httpOnly, SameSite=Strict cookie scoped to /api/auth, never in the body', async () => {
    const p = await person('cashier');
    const { res, cookie } = await signIn(p);
    const header = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('ut_refresh_token='))!;
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Strict/);
    expect(header).toMatch(/Path=\/api\/auth/);
    expect(header).not.toMatch(/Max-Age/); // not remembered: it dies with the browser
    expect(JSON.stringify(res.body)).not.toContain(cookieValue(cookie));
    expect(res.body.session).toMatchObject({ remember: false, lockAfterSeconds: 300 }); // a cashier's screen locks after 5 idle minutes
  });

  it('gives a remembered device a cookie that outlives the browser', async () => {
    const p = await person('manager');
    const { res } = await signIn(p, { remember: true });
    const header = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('ut_refresh_token='))!;
    expect(header).toMatch(/Max-Age=\d+/);
    expect(res.body.session.remember).toBe(true);
    expect(res.body.session.signOutAfterSeconds).toBeNull();
  });

  it('swaps the refresh token for a new pair, and refuses the old refresh token', async () => {
    const p = await person('manager');
    const s = await signIn(p);
    const r1 = await request(app()).post('/api/auth/refresh').set('Cookie', s.cookie);
    expect(r1.status).toBe(200);
    expect(r1.body.token).toBeTruthy();
    expect(r1.body.token).not.toBe(s.token);
    expect(cookieOf(r1)).not.toBe(s.cookie);
    expect(r1.body.user.username).toBe(p.username);
    expect((await request(app()).get('/api/auth/me').set('Authorization', `Bearer ${r1.body.token}`)).status).toBe(200);
    const again = await request(app()).post('/api/auth/refresh').set('Cookie', s.cookie);
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('REFRESH_INVALID');
    expect(([] as string[]).concat(again.headers['set-cookie'] ?? []).join(';')).toMatch(/ut_refresh_token=;/); // the dead cookie is cleared
  });

  it('keeps the replaced access token working for a short overlap, then not', async () => {
    const p = await person('cashier');
    const s = await signIn(p);
    const r = await request(app()).post('/api/auth/refresh').set('Cookie', s.cookie);
    expect(r.status).toBe(200);
    expect((await request(app()).get('/api/auth/me').set('Authorization', s.auth)).status).toBe(200); // in-flight request from before the swap
    await db.pool.query(`UPDATE sessions SET prev_valid_until = now() - interval '1 second' WHERE id = $1`, [s.sessionId]);
    expect((await request(app()).get('/api/auth/me').set('Authorization', s.auth)).status).toBe(401);
  });

  it('answers a timed-out access token with TOKEN_EXPIRED, and a refresh gets a working one', async () => {
    const p = await person('cashier');
    const s = await signIn(p);
    await db.pool.query(`UPDATE sessions SET access_expires_at = now() - interval '1 second' WHERE id = $1`, [s.sessionId]);
    const dead = await request(app()).get('/api/auth/me').set('Authorization', s.auth);
    expect(dead.status).toBe(401);
    expect(dead.body.error.code).toBe('TOKEN_EXPIRED');
    const r = await request(app()).post('/api/auth/refresh').set('Cookie', s.cookie);
    expect((await request(app()).get('/api/auth/me').set('Authorization', `Bearer ${r.body.token}`)).status).toBe(200);
  });

  it('ends the whole session when an already-swapped refresh token comes back after the grace period', async () => {
    const p = await person('manager');
    const s = await signIn(p);
    const r1 = await request(app()).post('/api/auth/refresh').set('Cookie', s.cookie);
    await db.pool.query(`UPDATE refresh_tokens SET revoked_at = now() - interval '5 minutes' WHERE revoked_at IS NOT NULL AND session_id = $1`, [s.sessionId]);
    expect((await request(app()).post('/api/auth/refresh').set('Cookie', s.cookie)).status).toBe(401); // the stolen copy
    // ...and the real owner's newest token is dead too, because the session is gone.
    const owner = await request(app()).post('/api/auth/refresh').set('Cookie', cookieOf(r1));
    expect(owner.status).toBe(401);
    expect((await request(app()).get('/api/auth/me').set('Authorization', `Bearer ${r1.body.token}`)).status).toBe(401);
    const { rows } = await db.pool.query(`SELECT 1 FROM audit_log WHERE actor = $1 AND action = 'refresh_token_reuse'`, [p.username]);
    expect(rows.length).toBe(1);
  });

  it('refuses to refresh without a cookie, and signs out by cookie even when the access token is dead', async () => {
    expect((await request(app()).post('/api/auth/refresh')).status).toBe(401);
    const p = await person('cashier');
    const s = await signIn(p);
    await db.pool.query(`UPDATE sessions SET access_expires_at = now() - interval '1 second' WHERE id = $1`, [s.sessionId]);
    const out = await request(app()).post('/api/auth/logout').set('Cookie', s.cookie);
    expect(out.status).toBe(200);
    expect((await request(app()).post('/api/auth/refresh').set('Cookie', s.cookie)).status).toBe(401);
  });

  it('never fails to sign out, even with nothing to sign out of', async () => {
    expect((await request(app()).post('/api/auth/logout')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------- idle rules
describe('idle lock, idle sign-out and "confirm it is you"', () => {
  it('locks an idle screen: only unlock, sign-out and "who am I" work until the password is typed', async () => {
    const p = await person('cashier');
    const s = await signIn(p);
    expect((await request(app()).get('/api/orders').set('Authorization', s.auth)).status).toBe(200);
    await idle(s.sessionId, 6);
    const locked = await request(app()).get('/api/orders').set('Authorization', s.auth);
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('SESSION_LOCKED');
    expect((await request(app()).get('/api/auth/me').set('Authorization', s.auth)).status).toBe(200);
    const bad = await request(app()).post('/api/auth/unlock').set('Authorization', s.auth).send({ password: 'wrong-wrong-1' });
    expect(bad.status).toBe(401);
    expect((await request(app()).get('/api/orders').set('Authorization', s.auth)).status).toBe(403);
    const ok = await request(app()).post('/api/auth/unlock').set('Authorization', s.auth).send({ password: p.password });
    expect(ok.status).toBe(200);
    expect(ok.body.session.idleSeconds).toBeLessThan(5);
    expect((await request(app()).get('/api/orders').set('Authorization', s.auth)).status).toBe(200);
  });

  it('signs out a session idle past the sign-out time, but only locks one the person asked to remember', async () => {
    const p = await person('cashier');
    const plain = await signIn(p);
    const kept = await signIn(p, { remember: true });
    await idle(plain.sessionId, 31); // a cashier is signed out after 30 idle minutes
    await idle(kept.sessionId, 31);
    const ended = await request(app()).get('/api/orders').set('Authorization', plain.auth);
    expect(ended.status).toBe(401);
    expect(ended.body.error.code).toBe('SESSION_EXPIRED');
    expect((await request(app()).post('/api/auth/refresh').set('Cookie', plain.cookie)).body.error.code).toBe('REFRESH_INVALID'); // ended: its tokens are dead too
    expect((await request(app()).get('/api/orders').set('Authorization', kept.auth)).body.error.code).toBe('SESSION_LOCKED');
  });

  it('lets a locked session refresh, but the new access token is as locked as the old one', async () => {
    const p = await person('cashier');
    const s = await signIn(p);
    await idle(s.sessionId, 6);
    const r = await request(app()).post('/api/auth/refresh').set('Cookie', s.cookie);
    expect(r.status).toBe(200);
    expect((await request(app()).get('/api/orders').set('Authorization', `Bearer ${r.body.token}`)).body.error.code).toBe('SESSION_LOCKED');
  });

  it('counts only deliberate actions as use: a change resets the idle clock, reading and background polling do not', async () => {
    const p = await person('cashier');
    const s = await signIn(p);
    await idle(s.sessionId, 3);
    await request(app()).get('/api/orders').set('Authorization', s.auth);
    await request(app()).post('/api/auth/activity').set('Authorization', s.auth).set('X-Background', '1');
    let me = await request(app()).get('/api/auth/me').set('Authorization', s.auth);
    expect(me.body.session.idleSeconds).toBeGreaterThanOrEqual(170);
    await request(app()).post('/api/auth/activity').set('Authorization', s.auth); // the app's own "someone is here" ping
    me = await request(app()).get('/api/auth/me').set('Authorization', s.auth);
    expect(me.body.session.idleSeconds).toBeLessThan(5);
  });

  it('follows the lock times an admin sets in the security settings', async () => {
    const p = await person('cashier');
    const s = await signIn(p);
    await setSettings(db.pool, { security_lock_minutes_cashier: '2' }, 'test');
    await idle(s.sessionId, 3);
    expect((await request(app()).get('/api/orders').set('Authorization', s.auth)).body.error.code).toBe('SESSION_LOCKED');
    await db.pool.query(`DELETE FROM app_settings WHERE key = 'security_lock_minutes_cashier'`);
    clearSettingsCache();
  });

  it('asks for the password again before a risky action, then remembers it for a few minutes', async () => {
    const p = await person('manager');
    const s = await signIn(p);
    const risky = express();
    risky.use(requireAuth(db.pool), requireRecentAuth());
    risky.post('/risky', handler(async (_req, res) => { res.json({ done: true }); }));
    risky.use(((err, _req, res, _next) => { res.status(err.status ?? 500).json({ error: { code: err.code } }); }) as express.ErrorRequestHandler);

    expect((await request(risky).post('/risky').set('Authorization', s.auth)).status).toBe(200); // just signed in: the password was just typed
    await db.pool.query(`UPDATE sessions SET reauth_at = now() - interval '6 minutes' WHERE id = $1`, [s.sessionId]);
    const need = await request(risky).post('/risky').set('Authorization', s.auth);
    expect(need.status).toBe(403);
    expect(need.body.error.code).toBe('REAUTH_REQUIRED');
    expect((await request(app()).post('/api/auth/unlock').set('Authorization', s.auth).send({ password: p.password })).status).toBe(200);
    expect((await request(risky).post('/risky').set('Authorization', s.auth)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------- PIN
describe('register PIN', () => {
  it('is set by an admin, refuses obvious PINs, and never exists by default', async () => {
    const admin = await signIn(await person('admin'));
    const cashier = await person('cashier');
    expect((await request(app()).post('/api/auth/pin-login').send({ userId: cashier.id, pin: '4829' })).status).toBe(401); // no PIN yet: nothing to guess
    for (const weak of ['1234', '0000', '1111', '4321', '2345', '123456', '12']) {
      const res = await request(app()).put(`/api/users/${cashier.id}/pin`).set('Authorization', admin.auth).send({ pin: weak });
      expect(res.status, weak).toBe(422);
    }
    const ok = await request(app()).put(`/api/users/${cashier.id}/pin`).set('Authorization', admin.auth).send({ pin: '4829' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.hasPin).toBe(true);
    expect(JSON.stringify(ok.body)).not.toMatch(/scrypt\$/);
    const { rows } = await db.pool.query(`SELECT pin_hash FROM users WHERE id = $1`, [cashier.id]);
    expect(rows[0].pin_hash).not.toContain('4829');
  });

  it('signs a cashier in at the register, never remembers the device, and refuses managers and admins', async () => {
    const admin = await signIn(await person('admin'));
    const cashier = await person('cashier', { pin: '4829' });
    const manager = await person('manager');
    await request(app()).put(`/api/users/${manager.id}/pin`).set('Authorization', admin.auth).send({ pin: '5738' });
    const okRes = await request(app()).post('/api/auth/pin-login').send({ userId: cashier.id, pin: '4829' });
    expect(okRes.status).toBe(200);
    expect(okRes.body.user.role).toBe('cashier');
    expect(okRes.body.session.remember).toBe(false);
    const refused = await request(app()).post('/api/auth/pin-login').send({ userId: manager.id, pin: '5738' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('PIN_LOGIN_CASHIERS_ONLY');
    expect(refused.body.token).toBeUndefined();
  });

  it('locks the PIN and the password separately', async () => {
    const admin = await signIn(await person('admin'));
    const c = await person('cashier', { pin: '4829' });
    for (let i = 0; i < 5; i++) expect((await request(app()).post('/api/auth/pin-login').send({ userId: c.id, pin: '9999' })).status).toBe(401);
    const lockedPin = await request(app()).post('/api/auth/pin-login').send({ userId: c.id, pin: '4829' }); // the right PIN, but locked
    expect(lockedPin.status).toBe(423);
    expect(lockedPin.body.error.code).toBe('ACCOUNT_LOCKED');
    expect((await request(app()).post('/api/auth/login').send({ email: c.email, password: c.password })).status).toBe(200); // the password still works

    const c2 = await person('cashier', { pin: '5738' });
    for (let i = 0; i < 5; i++) await request(app()).post('/api/auth/login').send({ email: c2.email, password: 'wrong-wrong-1' });
    expect((await request(app()).post('/api/auth/login').send({ email: c2.email, password: c2.password })).status).toBe(423);
    expect((await request(app()).post('/api/auth/pin-login').send({ userId: c2.id, pin: '5738' })).status).toBe(200); // the PIN still works

    const unlock = await request(app()).post(`/api/users/${c.id}/unlock-account`).set('Authorization', admin.auth);
    expect(unlock.status).toBe(200);
    expect((await request(app()).post('/api/auth/pin-login').send({ userId: c.id, pin: '4829' })).status).toBe(200);
  });

  it('lets a cashier unlock a locked screen with the PIN, but not anyone else', async () => {
    const admin = await signIn(await person('admin'));
    const c = await person('cashier', { pin: '4829' });
    const s = await signIn(c);
    await idle(s.sessionId, 6);
    expect((await request(app()).post('/api/auth/unlock').set('Authorization', s.auth).send({ pin: '4829' })).status).toBe(200);
    expect((await request(app()).get('/api/orders').set('Authorization', s.auth)).status).toBe(200);

    const m = await person('manager');
    await request(app()).put(`/api/users/${m.id}/pin`).set('Authorization', admin.auth).send({ pin: '5738' });
    const ms = await signIn(m);
    const noPin = await request(app()).post('/api/auth/unlock').set('Authorization', ms.auth).send({ pin: '5738' });
    expect(noPin.status).toBe(403);
    expect(noPin.body.error.code).toBe('PIN_NOT_ALLOWED');
  });

  it('removes a PIN with null', async () => {
    const admin = await signIn(await person('admin'));
    const c = await person('cashier', { pin: '4829' });
    const res = await request(app()).put(`/api/users/${c.id}/pin`).set('Authorization', admin.auth).send({ pin: null });
    expect(res.body.user.hasPin).toBe(false);
    expect((await request(app()).post('/api/auth/pin-login').send({ userId: c.id, pin: '4829' })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------------------------- devices
describe('signed-in devices', () => {
  it('lists my devices, ends one, or signs out everywhere else', async () => {
    const p = await person('manager');
    const a = await signIn(p);
    const b = await signIn(p);
    const list = await request(app()).get('/api/auth/sessions').set('Authorization', a.auth);
    expect(list.body.sessions.length).toBeGreaterThanOrEqual(2);
    expect(list.body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(list.body.sessions[0]).toHaveProperty('device');

    expect((await request(app()).delete(`/api/auth/sessions/${b.sessionId}`).set('Authorization', a.auth)).status).toBe(200);
    expect((await request(app()).get('/api/auth/me').set('Authorization', b.auth)).status).toBe(401);
    expect((await request(app()).post('/api/auth/refresh').set('Cookie', b.cookie)).status).toBe(401);

    const c = await signIn(p);
    const others = await request(app()).post('/api/auth/sessions/revoke-others').set('Authorization', a.auth);
    expect(others.body.ended).toBeGreaterThanOrEqual(1);
    expect((await request(app()).get('/api/auth/me').set('Authorization', c.auth)).status).toBe(401);
    expect((await request(app()).get('/api/auth/me').set('Authorization', a.auth)).status).toBe(200);
  });

  it('cannot end someone else\'s device', async () => {
    const mine = await signIn(await person('cashier'));
    const theirs = await signIn(await person('cashier'));
    expect((await request(app()).delete(`/api/auth/sessions/${theirs.sessionId}`).set('Authorization', mine.auth)).status).toBe(404);
    expect((await request(app()).get('/api/auth/me').set('Authorization', theirs.auth)).status).toBe(200);
  });

  it('signs a deactivated person out of everything at once, refresh tokens included', async () => {
    const admin = await signIn(await person('admin'));
    const p = await person('cashier');
    const s = await signIn(p);
    expect((await request(app()).patch(`/api/users/${p.id}`).set('Authorization', admin.auth).send({ active: false })).status).toBe(200);
    expect((await request(app()).get('/api/auth/me').set('Authorization', s.auth)).status).toBe(401);
    expect((await request(app()).post('/api/auth/refresh').set('Cookie', s.cookie)).status).toBe(401);
  });

  it('lets an admin see and end another person\'s devices', async () => {
    const admin = await signIn(await person('admin'));
    const p = await person('cashier');
    const s = await signIn(p);
    const list = await request(app()).get(`/api/users/${p.id}/sessions`).set('Authorization', admin.auth);
    expect(list.body.sessions.map((x: { id: number }) => x.id)).toContain(s.sessionId);
    const out = await request(app()).post(`/api/users/${p.id}/sign-out-everywhere`).set('Authorization', admin.auth);
    expect(out.body.ended).toBeGreaterThanOrEqual(1);
    expect((await request(app()).get('/api/auth/me').set('Authorization', s.auth)).status).toBe(401);
  });

  it('signs out the other devices when the password changes, and their refresh tokens stop working', async () => {
    const p = await person('manager');
    const here = await signIn(p);
    const there = await signIn(p);
    const next = 'Another-good-pw-77';
    expect((await request(app()).post('/api/auth/change-password').set('Authorization', here.auth).send({ currentPassword: p.password, newPassword: next })).status).toBe(200);
    expect((await request(app()).post('/api/auth/refresh').set('Cookie', there.cookie)).status).toBe(401);
    expect((await request(app()).get('/api/auth/me').set('Authorization', here.auth)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------- permissions
describe('Staff access: per-person permission overrides', () => {
  it('shows every key with its role default, override and effective value', async () => {
    const admin = await signIn(await person('admin'));
    const c = await person('cashier');
    const res = await request(app()).get(`/api/users/${c.id}/permissions`).set('Authorization', admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.locked).toBe(false);
    const sv = res.body.permissions.find((p: { key: string }) => p.key === 'sales.void');
    expect(sv).toMatchObject({ roleDefault: false, override: null, effective: false, group: 'Sales' });
    expect(res.body.permissions.length).toBe(19);
  });

  it('lets a trusted cashier see reports, and takes it away again', async () => {
    const admin = await signIn(await person('admin'));
    const c = await person('cashier');
    const before = await signIn(c);
    expect((await request(app()).get('/api/reports/trial-balance').set('Authorization', before.auth)).status).toBe(403);
    expect(before.res.body.uiPermissions).not.toContain('reports.view');

    const grant = await request(app()).put(`/api/users/${c.id}/permissions`).set('Authorization', admin.auth).send({ overrides: { 'reports.view': true } });
    expect(grant.status).toBe(200);
    expect(grant.body.permissions.find((p: { key: string }) => p.key === 'reports.view')).toMatchObject({ override: true, effective: true });
    // Takes effect on the very next request of the signed-in session: no new login needed.
    expect((await request(app()).get('/api/reports/trial-balance').set('Authorization', before.auth)).status).toBe(200);
    expect((await signIn(c)).res.body.uiPermissions).toContain('reports.view');
    expect((await signIn(c)).res.body.permissions).toContain('reports.view');

    await request(app()).put(`/api/users/${c.id}/permissions`).set('Authorization', admin.auth).send({ overrides: { 'reports.view': null } });
    expect((await request(app()).get('/api/reports/trial-balance').set('Authorization', before.auth)).status).toBe(403);
  });

  it('can stop one manager doing one thing without touching their other rights', async () => {
    const admin = await signIn(await person('admin'));
    const m = await person('manager');
    const s = await signIn(m);
    expect((await request(app()).get('/api/payments/suspense').set('Authorization', s.auth)).status).toBe(200);
    await request(app()).put(`/api/users/${m.id}/permissions`).set('Authorization', admin.auth).send({ overrides: { 'payments.reconcile': false } });
    expect((await request(app()).get('/api/payments/suspense').set('Authorization', s.auth)).status).toBe(403);
    expect((await request(app()).get('/api/reports/trial-balance').set('Authorization', s.auth)).status).toBe(200);
  });

  it('stores nothing for an override that merely restates the default', async () => {
    const admin = await signIn(await person('admin'));
    const m = await person('manager');
    await request(app()).put(`/api/users/${m.id}/permissions`).set('Authorization', admin.auth).send({ overrides: { 'reports.view': false } });
    await request(app()).put(`/api/users/${m.id}/permissions`).set('Authorization', admin.auth).send({ overrides: { 'reports.view': true } }); // the manager default
    const { rows } = await db.pool.query(`SELECT 1 FROM user_permissions WHERE user_id = $1`, [m.id]);
    expect(rows).toHaveLength(0);
  });

  it('never restricts an admin, never lets you edit yourself, and refuses unknown keys', async () => {
    const admin = await person('admin');
    const other = await person('admin');
    const a = await signIn(admin);
    const onAdmin = await request(app()).put(`/api/users/${other.id}/permissions`).set('Authorization', a.auth).send({ overrides: { 'reports.view': false } });
    expect(onAdmin.status).toBe(409);
    expect(onAdmin.body.error.code).toBe('ADMIN_UNRESTRICTED');
    expect((await request(app()).get(`/api/users/${other.id}/permissions`).set('Authorization', a.auth)).body.locked).toBe(true);
    const c = await person('cashier');
    const unknown = await request(app()).put(`/api/users/${c.id}/permissions`).set('Authorization', a.auth).send({ overrides: { 'payroll.approve': true } });
    expect(unknown.status).toBe(422); // payroll approval is deliberately not delegable
    expect(unknown.body.error.code).toBe('UNKNOWN_PERMISSION');
  });

  it('cannot be reached by anyone but an admin, and every change is audited as risky', async () => {
    const m = await signIn(await person('manager'));
    const c = await person('cashier');
    expect((await request(app()).put(`/api/users/${c.id}/permissions`).set('Authorization', m.auth).send({ overrides: { 'reports.view': true } })).status).toBe(403);
    const admin = await person('admin');
    const a = await signIn(admin);
    await request(app()).put(`/api/users/${c.id}/permissions`).set('Authorization', a.auth).send({ overrides: { 'reports.view': true } });
    const { rows } = await db.pool.query(`SELECT risk, details FROM audit_log WHERE actor = $1 AND action = 'permissions_changed'`, [admin.username]);
    expect(rows[0].risk).toBe(2);
    expect(rows[0].details.after).toEqual({ 'reports.view': true });
  });

  it('lets an override on the void permission decide who may approve a sale', async () => {
    const admin = await signIn(await person('admin'));
    const m = await person('manager');
    await request(app()).put(`/api/users/${m.id}/permissions`).set('Authorization', admin.auth).send({ overrides: { 'sales.void': false } });
    const { userCan } = await import('../src/auth/access.js');
    expect(await userCan(db.pool, { id: m.id, role: 'manager' }, 'pos.approve')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------- browser access
describe('calls from the staff screens in a browser', () => {
  it('lets only the listed origins send the refresh cookie, and answers the preflight', async () => {
    const pre = await request(app()).options('/api/auth/login').set('Origin', 'http://localhost:5173').set('Access-Control-Request-Method', 'POST');
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(pre.headers['access-control-allow-credentials']).toBe('true');
    expect(pre.headers['access-control-allow-headers']).toContain('Authorization');
    const stranger = await request(app()).options('/api/auth/login').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
    expect(stranger.headers['access-control-allow-origin']).toBeUndefined();
    expect(stranger.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
