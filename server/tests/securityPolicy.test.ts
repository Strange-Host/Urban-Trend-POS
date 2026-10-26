import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Role } from '../src/auth/permissions.js';
import { createUser } from '../src/auth/service.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';
import { makeTestDb, type TestDb } from './helpers.js';

let db: TestDb;
const app = () => createApp({ pool: db.pool, logger: createLogger('silent') });
beforeAll(async () => { db = await makeTestDb(); await runMigrations(db.pool); });
afterAll(() => db.drop());

let n = 0;
interface P { id: number; username: string; email: string; password: string }
async function person(role: Role): Promise<P> {
  const username = `${role}${++n}s${Math.random().toString(36).slice(2, 6)}`;
  const email = `${username}@shop.test`;
  const { user, temporaryPassword } = await createUser(db.pool, { username, displayName: `Test ${role}`, role, email, actor: 'test-setup' });
  const first = await request(app()).post('/api/auth/login').send({ email, password: temporaryPassword });
  const password = `Better-${Math.random().toString(36).slice(2, 12)}-pw`;
  await request(app()).post('/api/auth/change-password').set('Authorization', `Bearer ${first.body.token}`).send({ currentPassword: temporaryPassword, newPassword: password });
  return { id: user.id, username, email, password };
}
const signIn = async (p: P, extra: Record<string, unknown> = {}) => {
  const res = await request(app()).post('/api/auth/login').send({ email: p.email, password: p.password, ...extra });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('ut_refresh_token='))!.split(';')[0]!;
  return { res, auth: `Bearer ${res.body.token}`, cookie, sessionId: res.body.session.id as number };
};
const hoursLeft = async (sessionId: number) => Number((await db.pool.query(`SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) / 3600 AS h FROM sessions WHERE id = $1`, [sessionId])).rows[0].h);

describe('the security policy editor', () => {
  it('shows the legacy defaults, and rejects a lock time that is not before the sign-out time or a lockout that is too low', async () => {
    const admin = await signIn(await person('admin'));
    const get = await request(app()).get('/api/security/policy').set('Authorization', admin.auth);
    expect(get.body.policy.roles.cashier).toEqual({ lockMinutes: 5, idleSignOutMinutes: 30, maxHours: 12 });
    expect(get.body.policy.roles.manager).toEqual({ lockMinutes: 10, idleSignOutMinutes: 60, maxHours: 168 });
    expect(get.body.policy.lockout).toEqual({ attempts: 5, minutes: 15 });
    expect(get.body.policy).toMatchObject({ unrememberedMaxHours: 12, reauthMinutes: 5, alerts: { refundKes: 3000, stockUnits: 25, pricePercent: 15 } });

    const bad = await request(app()).put('/api/security/policy').set('Authorization', admin.auth).send({ roles: { cashier: { lockMinutes: 40, idleSignOutMinutes: 30 } } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/signing out must come after/);
    expect((await request(app()).put('/api/security/policy').set('Authorization', admin.auth).send({ lockout: { attempts: 1 } })).status).toBe(422);
    expect((await request(app()).put('/api/security/policy').set('Authorization', admin.auth).send({ lockout: { attempts: 'lots' } })).status).toBe(422);
    expect((await request(app()).put('/api/security/policy').set('Authorization', admin.auth).send({ nonsense: 1 })).status).toBe(422);
    expect((await request(app()).get('/api/security/policy').set('Authorization', admin.auth)).body.policy.lockout.attempts).toBe(5); // nothing was half-saved
  });

  it('saves changes, applies them to new sessions at once, and audits the change', async () => {
    const admin = await person('admin');
    const a = await signIn(admin);
    const ok = await request(app()).put('/api/security/policy').set('Authorization', a.auth).send({ roles: { cashier: { lockMinutes: 3, idleSignOutMinutes: 20, maxHours: 10 } } });
    expect(ok.status).toBe(200);
    expect(ok.body.policy.roles.cashier).toEqual({ lockMinutes: 3, idleSignOutMinutes: 20, maxHours: 10 });
    expect(ok.body.policy.roles.manager.lockMinutes).toBe(10); // the rest untouched
    const c = await person('cashier');
    const s = await signIn(c);
    expect(s.res.body.session.lockAfterSeconds).toBe(180);
    expect(s.res.body.session.signOutAfterSeconds).toBe(1200);
    expect(await hoursLeft(s.sessionId)).toBeCloseTo(10, 1);
    const { rows } = await db.pool.query(`SELECT risk FROM audit_log WHERE actor = $1 AND action = 'security_policy_changed'`, [admin.username]);
    expect(rows).toHaveLength(1);
    await request(app()).put('/api/security/policy').set('Authorization', a.auth).send({ roles: { cashier: { lockMinutes: 5, idleSignOutMinutes: 30, maxHours: 12 } } }); // restore
  });

  it('changes how many wrong passwords lock an account', async () => {
    const admin = await signIn(await person('admin'));
    await request(app()).put('/api/security/policy').set('Authorization', admin.auth).send({ lockout: { attempts: 3, minutes: 5 } });
    const c = await person('cashier');
    for (let i = 0; i < 3; i++) await request(app()).post('/api/auth/login').send({ email: c.email, password: 'wrong-wrong-1' });
    const locked = await request(app()).post('/api/auth/login').send({ email: c.email, password: c.password });
    expect(locked.status).toBe(423);
    expect(locked.body.error.message).toMatch(/5 minutes/);
    await request(app()).put('/api/security/policy').set('Authorization', admin.auth).send({ lockout: { attempts: 5, minutes: 15 } });
  });

  it('is for admins only, and a change asks for the password again when it was not typed recently', async () => {
    const m = await signIn(await person('manager'));
    expect((await request(app()).get('/api/security/policy').set('Authorization', m.auth)).status).toBe(403);
    expect((await request(app()).put('/api/security/policy').set('Authorization', m.auth).send({})).status).toBe(403);
    const adm = await person('admin');
    const a = await signIn(adm);
    await db.pool.query(`UPDATE sessions SET reauth_at = now() - interval '10 minutes' WHERE id = $1`, [a.sessionId]);
    expect((await request(app()).get('/api/security/policy').set('Authorization', a.auth)).status).toBe(200); // reading is free
    const need = await request(app()).put('/api/security/policy').set('Authorization', a.auth).send({ reauthMinutes: 10 });
    expect(need.body.error.code).toBe('REAUTH_REQUIRED');
    await request(app()).post('/api/auth/unlock').set('Authorization', a.auth).send({ password: adm.password });
    expect((await request(app()).put('/api/security/policy').set('Authorization', a.auth).send({ reauthMinutes: 5 })).status).toBe(200);
  });
});

// Ported from the legacy sessionsAndLockout / staff / forcedPasswordChange tests: the rules that were not yet covered.
describe('session length and activity rules', () => {
  it('caps a session that is not remembered at 12 hours, and a remembered one at the role maximum', async () => {
    const m = await person('manager');
    const plain = await signIn(m);
    const kept = await signIn(m, { remember: true });
    expect(await hoursLeft(plain.sessionId)).toBeCloseTo(12, 1);
    expect(await hoursLeft(kept.sessionId)).toBeCloseTo(168, 1); // a manager's maximum, a week
    const c = await signIn(await person('cashier'), { remember: true });
    expect(await hoursLeft(c.sessionId)).toBeCloseTo(12, 1);
  });

  it('enforces the maximum however active the person is, for the token and for refreshing', async () => {
    const s = await signIn(await person('cashier'));
    await request(app()).post('/api/auth/activity').set('Authorization', s.auth); // busy right up to the end
    await db.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id = $1`, [s.sessionId]);
    expect((await request(app()).get('/api/orders').set('Authorization', s.auth)).body.error.code).toBe('SESSION_EXPIRED');
    expect((await request(app()).post('/api/auth/refresh').set('Cookie', s.cookie)).status).toBe(401);
  });

  it('lets a refresh keep the session going without counting as activity or stretching its maximum', async () => {
    const s = await signIn(await person('cashier'));
    const before = await db.pool.query(`SELECT expires_at FROM sessions WHERE id = $1`, [s.sessionId]);
    await db.pool.query(`UPDATE sessions SET last_activity_at = now() - interval '3 minutes' WHERE id = $1`, [s.sessionId]);
    const r = await request(app()).post('/api/auth/refresh').set('Cookie', s.cookie);
    expect(r.status).toBe(200);
    expect(r.body.session.idleSeconds).toBeGreaterThanOrEqual(179); // still three minutes idle: a refresh is not someone using the app
    const after = await db.pool.query(`SELECT expires_at FROM sessions WHERE id = $1`, [s.sessionId]);
    expect(after.rows[0].expires_at).toEqual(before.rows[0].expires_at);
    const refreshCookieLife = await db.pool.query(`SELECT expires_at <= (SELECT expires_at FROM sessions WHERE id = $1) AS ok FROM refresh_tokens WHERE session_id = $1 AND revoked_at IS NULL`, [s.sessionId]);
    expect(refreshCookieLife.rows[0].ok).toBe(true); // a rotated refresh token never outlives its session
  });

  it('resets the wrong-password counter after a good sign-in', async () => {
    const c = await person('cashier');
    for (let i = 0; i < 4; i++) await request(app()).post('/api/auth/login').send({ email: c.email, password: 'nope-nope-nope' });
    expect((await request(app()).post('/api/auth/login').send({ email: c.email, password: c.password })).status).toBe(200);
    for (let i = 0; i < 4; i++) await request(app()).post('/api/auth/login').send({ email: c.email, password: 'nope-nope-nope' });
    expect((await request(app()).post('/api/auth/login').send({ email: c.email, password: c.password })).status).toBe(200); // 4 + 4 is not 5 in a row
  });

  it('puts the session id in the answer and signs in a new account that must then change its one-time password', async () => {
    const { temporaryPassword } = await createUser(db.pool, { username: `fresh${++n}`, displayName: 'Fresh', role: 'cashier', email: `fresh${n}@shop.test`, actor: 'test-setup' });
    const res = await request(app()).post('/api/auth/login').send({ email: `fresh${n}@shop.test`, password: temporaryPassword });
    expect(res.body.session.id).toBeGreaterThan(0);
    expect(res.body.user.mustChangePassword).toBe(true);
    expect((await request(app()).get('/api/orders').set('Authorization', `Bearer ${res.body.token}`)).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});

describe('editing a person', () => {
  it('changing a harmless field does not sign them out, but a role change does', async () => {
    const admin = await signIn(await person('admin'));
    const p = await person('cashier');
    const s = await signIn(p);
    expect((await request(app()).patch(`/api/users/${p.id}`).set('Authorization', admin.auth).send({ displayName: 'New Name', phone: '0722000111' })).status).toBe(200);
    expect((await request(app()).get('/api/auth/me').set('Authorization', s.auth)).status).toBe(200);
    expect((await request(app()).post('/api/auth/refresh').set('Cookie', s.cookie)).status).toBe(200);
    await request(app()).patch(`/api/users/${p.id}`).set('Authorization', admin.auth).send({ role: 'manager' });
    expect((await request(app()).get('/api/auth/me').set('Authorization', s.auth)).status).toBe(401);
  });
});
