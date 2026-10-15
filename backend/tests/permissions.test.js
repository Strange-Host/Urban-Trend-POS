const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const permissions = require('../src/config/permissions');
const permissionsService = require('../src/services/permissions.service');

let adminToken;
let adminId;
let manager;
let cashier;

const auth = (t) => ({ Authorization: `Bearer ${t}` });

async function makeUser(role, email) {
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  const r = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(store.id, `${role} perm`, email, bcrypt.hashSync('Passw0rd!Passw0rd', 10), role);
  const login = await request(app).post('/api/auth/login').send({ email, password: 'Passw0rd!Passw0rd' });
  return { id: r.lastInsertRowid, token: login.body.token, loginBody: login.body };
}

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  adminId = db.prepare(`SELECT id FROM users WHERE email = 'admin@urbantrends.com'`).get().id;
  manager = await makeUser('manager', 'perm-manager@urbantrends.com');
  cashier = await makeUser('cashier', 'perm-cashier@urbantrends.com');
});

afterAll(() => cleanupTestDb());

describe('permissions — defaults reproduce the old role gates', () => {
  it('manager can view staff and reports; cashier cannot', async () => {
    expect((await request(app).get('/api/staff').set(auth(manager.token))).status).toBe(200);
    expect((await request(app).get('/api/staff').set(auth(cashier.token))).status).toBe(403);
    expect((await request(app).get('/api/reports/dashboard').set(auth(cashier.token))).status).toBe(403);
    expect((await request(app).get('/api/reports/dashboard').set(auth(manager.token))).status).not.toBe(403);
  });

  it('every catalogue key has valid default roles and a group/label', () => {
    for (const [key, p] of Object.entries(permissions.PERMISSIONS)) {
      expect(p.group, key).toBeTruthy();
      expect(p.label, key).toBeTruthy();
      for (const r of p.roles) expect(permissions.ROLES).toContain(r);
    }
  });

  it('an unknown permission key is denied, never silently allowed', () => {
    expect(permissionsService.can({ id: manager.id, role: 'manager' }, 'nope.nothing')).toBe(false);
    expect(permissionsService.can({ id: adminId, role: 'admin' }, 'nope.nothing')).toBe(false);
  });

  it('sign-in responses carry the effective permission list', () => {
    expect(manager.loginBody.user.permissions).toContain('staff.view');
    expect(cashier.loginBody.user.permissions).not.toContain('staff.view');
    expect(manager.loginBody.user.token_version).toBeUndefined(); // internal field no longer leaks
    expect(manager.loginBody.user.password_hash).toBeUndefined();
  });
});

describe('permissions — per-user overrides', () => {
  it('grants one permission to a cashier immediately, without granting others', async () => {
    const put = await request(app).put(`/api/staff/${cashier.id}/permissions`).set(auth(adminToken)).send({ overrides: { 'staff.view': true } });
    expect(put.status).toBe(200);
    const row = put.body.data.permissions.find((p) => p.key === 'staff.view');
    expect(row).toMatchObject({ role_default: false, override: true, effective: true });

    // same token as before — checked per request, no re-login needed
    expect((await request(app).get('/api/staff').set(auth(cashier.token))).status).toBe(200);
    expect((await request(app).get('/api/reports/dashboard').set(auth(cashier.token))).status).toBe(403);
  });

  it('revokes one permission from a manager', async () => {
    await request(app).put(`/api/staff/${manager.id}/permissions`).set(auth(adminToken)).send({ overrides: { 'staff.view': false } });
    expect((await request(app).get('/api/staff').set(auth(manager.token))).status).toBe(403);
    expect((await request(app).get('/api/reports/dashboard').set(auth(manager.token))).status).not.toBe(403);
  });

  it('null removes the override and an override that restates the default is not stored', async () => {
    await request(app).put(`/api/staff/${manager.id}/permissions`).set(auth(adminToken)).send({ overrides: { 'staff.view': null } });
    expect((await request(app).get('/api/staff').set(auth(manager.token))).status).toBe(200);

    await request(app).put(`/api/staff/${manager.id}/permissions`).set(auth(adminToken)).send({ overrides: { 'reports.view': true } }); // already the manager default
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_permissions WHERE user_id = ?').get(manager.id).n).toBe(0);
  });

  it('records the change in the audit log', () => {
    const rows = db.prepare(`SELECT * FROM staff_logs WHERE entity_type = 'user_permissions' AND entity_id = ?`).all(cashier.id);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('refuses unknown keys, bad values, restricting an admin, and editing your own permissions', async () => {
    const put = (id, overrides) => request(app).put(`/api/staff/${id}/permissions`).set(auth(adminToken)).send({ overrides });
    expect((await put(cashier.id, { 'made.up': true })).status).toBe(400);
    expect((await put(cashier.id, { 'staff.view': 'yes' })).status).toBe(400);
    expect((await put(adminId, { 'staff.view': false })).status).toBe(400);
    expect((await request(app).put(`/api/staff/${cashier.id}/permissions`).set(auth(adminToken)).send({})).status).toBe(400);
    expect((await put(999999, { 'staff.view': true })).status).toBe(404);
  });

  it('only admins can read or change permissions', async () => {
    expect((await request(app).get(`/api/staff/${cashier.id}/permissions`).set(auth(manager.token))).status).toBe(403);
    expect((await request(app).put(`/api/staff/${cashier.id}/permissions`).set(auth(manager.token)).send({ overrides: { 'sales.void': true } })).status).toBe(403);
    expect((await request(app).get(`/api/staff/${cashier.id}/permissions`).set(auth(cashier.token))).status).toBe(403);
  });

  it('admin always passes, even if an override row somehow exists', () => {
    db.prepare(`INSERT OR REPLACE INTO user_permissions (user_id, permission, granted) VALUES (?, 'staff.view', 0)`).run(adminId);
    expect(permissionsService.can({ id: adminId, role: 'admin' }, 'staff.view')).toBe(true);
    db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(adminId);
  });

  it('the editor payload lists every permission with default, override and effective values', async () => {
    const res = await request(app).get(`/api/staff/${cashier.id}/permissions`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.locked).toBe(false);
    expect(res.body.data.permissions).toHaveLength(Object.keys(permissions.PERMISSIONS).length);
    expect(res.body.data.permissions.find((p) => p.key === 'staff.view').effective).toBe(true);
  });
});
