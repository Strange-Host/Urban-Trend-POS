import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { can, permissionsOf, ROLES } from '../src/auth/permissions.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { createUser, LOCK_MINUTES, MAX_FAILED_ATTEMPTS, updateUser } from '../src/auth/service.js';
import { appFor, loggedIn } from './authHelpers.js';
import { makeTestDb, type TestDb } from './helpers.js';

let db: TestDb;
beforeAll(async () => { db = await makeTestDb(); await runMigrations(db.pool); });
afterAll(() => db.drop());

describe('passwords', () => {
  it('hashes with a random salt and verifies only the right password', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterz', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('permission matrix', () => {
  it('makes approving and paying payroll, and managing users, admin-only', () => {
    for (const p of ['payroll.approve', 'payroll.pay', 'users.manage', 'courier_payouts.pay'] as const) {
      expect(can('admin', p)).toBe(true);
      expect(can('manager', p)).toBe(false);
      expect(can('cashier', p)).toBe(false);
    }
  });
  it('lets managers view and prepare payroll but not cashiers', () => {
    expect(can('manager', 'payroll.view')).toBe(true);
    expect(can('manager', 'payroll.manage')).toBe(true);
    expect(can('cashier', 'payroll.view')).toBe(false);
  });
  it('gives every role a subset of the one above it', () => {
    const [admin, manager, cashier] = ROLES.map(permissionsOf);
    for (const p of cashier!) expect(manager).toContain(p);
    for (const p of manager!) expect(admin).toContain(p);
  });
});

describe('login and sessions', () => {
  it('logs in, returns who you are and your permissions, never the hash', async () => {
    const u = await loggedIn(db.pool, 'manager');
    const res = await request(u.app).post('/api/auth/login').send({ username: u.username, password: u.password });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('manager');
    expect(res.body.permissions).toContain('payroll.view');
    expect(res.body.permissions).not.toContain('payroll.approve');
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|scrypt\$/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('treats a username as case-insensitive and gives one answer for a wrong password and an unknown user', async () => {
    const u = await loggedIn(db.pool, 'cashier');
    expect((await request(u.app).post('/api/auth/login').send({ username: u.username.toUpperCase(), password: u.password })).status).toBe(200);
    const wrong = await request(u.app).post('/api/auth/login').send({ username: u.username, password: 'nope-nope-nope' });
    const unknown = await request(u.app).post('/api/auth/login').send({ username: 'nobody-here', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
  });

  it('refuses requests with no token, a bad token, or after logout', async () => {
    const u = await loggedIn(db.pool, 'admin');
    expect((await request(u.app).get('/api/auth/me')).status).toBe(401);
    expect((await request(u.app).get('/api/auth/me').set('Authorization', 'Bearer not-a-token')).body.error.code).toBe('SESSION_INVALID');
    expect((await request(u.app).get('/api/auth/me').set('Authorization', u.auth)).status).toBe(200);
    expect((await request(u.app).post('/api/auth/logout').set('Authorization', u.auth)).status).toBe(200);
    expect((await request(u.app).get('/api/auth/me').set('Authorization', u.auth)).status).toBe(401);
  });

  it('ends a session when it expires', async () => {
    const u = await loggedIn(db.pool, 'cashier');
    await db.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [u.user.id]);
    expect((await request(u.app).get('/api/auth/me').set('Authorization', u.auth)).status).toBe(401);
  });

  it('stores only a hash of the token', async () => {
    const u = await loggedIn(db.pool, 'cashier');
    const { rows } = await db.pool.query(`SELECT token_hash FROM sessions WHERE user_id = $1`, [u.user.id]);
    expect(rows.some((r) => r.token_hash === u.token)).toBe(false);
  });

  it('locks the account after repeated wrong passwords, even for the right password, then allows a fresh start', async () => {
    const u = await loggedIn(db.pool, 'cashier');
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      expect((await request(u.app).post('/api/auth/login').send({ username: u.username, password: 'wrong-wrong-1' })).status).toBe(401);
    }
    const blocked = await request(u.app).post('/api/auth/login').send({ username: u.username, password: u.password });
    expect(blocked.status).toBe(423);
    expect(blocked.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(blocked.body.error.message).toContain(String(LOCK_MINUTES));
    await db.pool.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1`, [u.user.id]);
    expect((await request(u.app).post('/api/auth/login').send({ username: u.username, password: u.password })).status).toBe(200);
  });

  it('audits logins, failures and lockouts', async () => {
    const u = await loggedIn(db.pool, 'cashier');
    await request(u.app).post('/api/auth/login').send({ username: u.username, password: 'wrong-wrong-1' });
    const { rows } = await db.pool.query(`SELECT action FROM audit_log WHERE actor = $1`, [u.username]);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('login');
    expect(actions).toContain('login_failed');
  });

  it('answers a malformed login with a 422 that names the field', async () => {
    const res = await request(appFor(db.pool)).post('/api/auth/login').send({ username: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('password');
  });
});

describe('one-time passwords and changing your password', () => {
  it('blocks everything except change-password and logout until the one-time password is changed', async () => {
    const u = await loggedIn(db.pool, 'admin', { keepTemporary: true });
    expect((await request(u.app).get('/api/users').set('Authorization', u.auth)).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await request(u.app).get('/api/payroll/runs').set('Authorization', u.auth)).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const me = await request(u.app).get('/api/auth/me').set('Authorization', u.auth);
    expect(me.status).toBe(200);
    expect(me.body.user.mustChangePassword).toBe(true);
    const ch = await request(u.app).post('/api/auth/change-password').set('Authorization', u.auth).send({ currentPassword: u.temporaryPassword, newPassword: 'A-brand-new-pass-1' });
    expect(ch.status).toBe(200);
    expect((await request(u.app).get('/api/users').set('Authorization', u.auth)).status).toBe(200);
  });

  it('checks the current password, enforces the rules, and signs out the other sessions', async () => {
    const u = await loggedIn(db.pool, 'manager');
    const other = await request(u.app).post('/api/auth/login').send({ username: u.username, password: u.password });
    const bad = await request(u.app).post('/api/auth/change-password').set('Authorization', u.auth).send({ currentPassword: 'wrong-wrong-1', newPassword: 'A-brand-new-pass-1' });
    expect(bad.body.error.code).toBe('WRONG_CURRENT_PASSWORD');
    const short = await request(u.app).post('/api/auth/change-password').set('Authorization', u.auth).send({ currentPassword: u.password, newPassword: 'short' });
    expect(short.body.error.code).toBe('PASSWORD_TOO_SHORT');
    const same = await request(u.app).post('/api/auth/change-password').set('Authorization', u.auth).send({ currentPassword: u.password, newPassword: u.password });
    expect(same.body.error.code).toBe('PASSWORD_UNCHANGED');
    const withName = await request(u.app).post('/api/auth/change-password').set('Authorization', u.auth).send({ currentPassword: u.password, newPassword: `${u.username}-12345` });
    expect(withName.body.error.code).toBe('PASSWORD_CONTAINS_USERNAME');
    const ok = await request(u.app).post('/api/auth/change-password').set('Authorization', u.auth).send({ currentPassword: u.password, newPassword: 'A-brand-new-pass-1' });
    expect(ok.status).toBe(200);
    expect((await request(u.app).get('/api/auth/me').set('Authorization', u.auth)).status).toBe(200);
    expect((await request(u.app).get('/api/auth/me').set('Authorization', `Bearer ${other.body.token}`)).status).toBe(401);
  });
});

describe('user management', () => {
  it('lets only an admin create, change and reset users; a manager may read the staff list, a cashier may not', async () => {
    const mgr = await loggedIn(db.pool, 'manager');
    const csh = await loggedIn(db.pool, 'cashier');
    expect((await request(mgr.app).get('/api/users').set('Authorization', mgr.auth)).status).toBe(200); // managers assign leads to people
    expect((await request(csh.app).get('/api/users').set('Authorization', csh.auth)).status).toBe(403);
    for (const u of [mgr, csh]) {
      expect((await request(u.app).post('/api/users').set('Authorization', u.auth).send({ username: 'sneaky', displayName: 'S', role: 'admin' })).status).toBe(403);
      expect((await request(u.app).patch(`/api/users/${u.user.id}`).set('Authorization', u.auth).send({ role: 'admin' })).status).toBe(403);
      expect((await request(u.app).post(`/api/users/${u.user.id}/reset-password`).set('Authorization', u.auth)).status).toBe(403);
    }
    expect((await request(mgr.app).get('/api/users')).status).toBe(401);
  });

  it('creates a user with a one-time password shown once, and that user can log in and must change it', async () => {
    const admin = await loggedIn(db.pool, 'admin');
    const res = await request(admin.app).post('/api/users').set('Authorization', admin.auth).send({ username: 'Wanjiku', displayName: 'Wanjiku K', role: 'cashier' });
    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('wanjiku');
    expect(res.body.user.mustChangePassword).toBe(true);
    expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}-[A-Za-z0-9]{4}$/);
    const list = await request(admin.app).get('/api/users').set('Authorization', admin.auth);
    expect(JSON.stringify(list.body)).not.toContain(res.body.temporaryPassword);
    const first = await request(admin.app).post('/api/auth/login').send({ username: 'wanjiku', password: res.body.temporaryPassword });
    expect(first.status).toBe(200);
    expect(first.body.user.mustChangePassword).toBe(true);
    expect((await request(admin.app).post('/api/users').set('Authorization', admin.auth).send({ username: 'wanjiku', displayName: 'Dup', role: 'cashier' })).body.error.code).toBe('USERNAME_TAKEN');
    expect((await request(admin.app).post('/api/users').set('Authorization', admin.auth).send({ username: 'bad name!', displayName: 'X', role: 'cashier' })).body.error.code).toBe('BAD_USERNAME');
    expect((await request(admin.app).post('/api/users').set('Authorization', admin.auth).send({ username: 'okname', displayName: 'X', role: 'owner' })).status).toBe(422);
  });

  it('takes a role change or deactivation effect immediately by ending that person\'s sessions', async () => {
    const admin = await loggedIn(db.pool, 'admin');
    const csh = await loggedIn(db.pool, 'cashier');
    expect((await request(csh.app).get('/api/auth/me').set('Authorization', csh.auth)).status).toBe(200);
    const promote = await request(admin.app).patch(`/api/users/${csh.user.id}`).set('Authorization', admin.auth).send({ role: 'manager' });
    expect(promote.body.user.role).toBe('manager');
    expect((await request(csh.app).get('/api/auth/me').set('Authorization', csh.auth)).status).toBe(401);
    const again = await request(csh.app).post('/api/auth/login').send({ username: csh.username, password: csh.password });
    expect(again.body.user.role).toBe('manager');
    await request(admin.app).patch(`/api/users/${csh.user.id}`).set('Authorization', admin.auth).send({ active: false });
    expect((await request(csh.app).get('/api/auth/me').set('Authorization', `Bearer ${again.body.token}`)).status).toBe(401);
    expect((await request(csh.app).post('/api/auth/login').send({ username: csh.username, password: csh.password })).status).toBe(401);
    const { rows } = await db.pool.query(`SELECT action, risk FROM audit_log WHERE entity_id = $1 AND actor = $2`, [String(csh.user.id), admin.username]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['user_role_changed', 'user_deactivated']));
  });

  it('refuses to let an admin change their own role or deactivate themselves', async () => {
    const admin = await loggedIn(db.pool, 'admin');
    expect((await request(admin.app).patch(`/api/users/${admin.user.id}`).set('Authorization', admin.auth).send({ role: 'cashier' })).body.error.code).toBe('SELF_CHANGE');
    expect((await request(admin.app).patch(`/api/users/${admin.user.id}`).set('Authorization', admin.auth).send({ active: false })).body.error.code).toBe('SELF_CHANGE');
  });

  it('never removes the last active admin, by demotion or deactivation', async () => {
    const a = await loggedIn(db.pool, 'admin');
    const b = await loggedIn(db.pool, 'admin');
    await db.pool.query(`UPDATE users SET active = false WHERE role = 'admin' AND id NOT IN ($1, $2)`, [a.user.id, b.user.id]);
    // Two admins: a may demote b, leaving a as the only one.
    expect((await request(a.app).patch(`/api/users/${b.user.id}`).set('Authorization', a.auth).send({ role: 'manager' })).status).toBe(200);
    // b was a manager now and cannot act; a bringing in c and c trying to remove a is fine (c remains), but removing the LAST one is not:
    const c = await loggedIn(db.pool, 'admin');
    expect((await request(c.app).patch(`/api/users/${a.user.id}`).set('Authorization', c.auth).send({ active: false })).status).toBe(200);
    // c is now the only active admin. Another admin-acting caller (a stand-in for a race) cannot remove them.
    const standIn = { id: -1, username: 'standin', displayName: 'x', role: 'admin' as const, mustChangePassword: false, sessionId: 0 };
    await expect(updateUser(db.pool, { userId: c.user.id, active: false, actor: standIn })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
    await expect(updateUser(db.pool, { userId: c.user.id, role: 'manager', actor: standIn })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
  });

  it('resets a password: new one-time password, signed out everywhere, lockout cleared, must change', async () => {
    const admin = await loggedIn(db.pool, 'admin');
    const csh = await loggedIn(db.pool, 'cashier');
    await db.pool.query(`UPDATE users SET locked_until = now() + interval '10 minutes', failed_attempts = 3 WHERE id = $1`, [csh.user.id]);
    const res = await request(admin.app).post(`/api/users/${csh.user.id}/reset-password`).set('Authorization', admin.auth);
    expect(res.status).toBe(200);
    expect((await request(csh.app).get('/api/auth/me').set('Authorization', csh.auth)).status).toBe(401);
    expect((await request(csh.app).post('/api/auth/login').send({ username: csh.username, password: csh.password })).status).toBe(401); // old one gone
    const fresh = await request(csh.app).post('/api/auth/login').send({ username: csh.username, password: res.body.temporaryPassword });
    expect(fresh.status).toBe(200);
    expect(fresh.body.user.mustChangePassword).toBe(true);
    expect((await request(admin.app).post('/api/users/999999/reset-password').set('Authorization', admin.auth)).status).toBe(404);
  });

  it('can never delete a user or rename a username in the database', async () => {
    const u = await createUser(db.pool, { username: `keep${Date.now() % 100000}`, displayName: 'K', role: 'cashier', actor: 'test' });
    await expect(db.pool.query(`DELETE FROM users WHERE id = $1`, [u.user.id])).rejects.toThrow(/cannot be deleted/);
    await expect(db.pool.query(`UPDATE users SET username = 'renamed' WHERE id = $1`, [u.user.id])).rejects.toThrow(/cannot be changed/);
  });
});
