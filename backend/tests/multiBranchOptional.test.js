const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const modules = require('../src/services/modules.service');

// Multi-branch mode is optional: with it off the system is one shop, the branch-only API is closed (404
// MODULE_DISABLED), and a store_id in a request can no longer reach another branch. Nothing is deleted.

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'Passw0rd!Passw0rd';
const get = (path, token) => request(app).get(path).set(auth(token));
const setBranches = (token, on) => request(app).put('/api/modules').set(auth(token)).send({ branches: on });

let admin;
let mainId;
let outletId;
let outletStaffEmail;

afterAll(() => cleanupTestDb());

beforeAll(async () => {
  admin = await loginAsAdmin();
  mainId = db.prepare('SELECT id FROM stores WHERE is_main = 1').get().id;
});

describe('the default depends on how many branches exist', () => {
  it('is off for a one-branch shop and on once a second branch exists', () => {
    db.prepare(`DELETE FROM settings WHERE key = 'module_branches_enabled'`).run();
    expect(db.prepare('SELECT COUNT(*) c FROM stores WHERE is_active = 1').get().c).toBe(1);
    expect(modules.isEnabled('branches')).toBe(false);
    outletId = db.prepare(`INSERT INTO stores (name, address, is_main) VALUES ('Optional Outlet', 'Westlands', 0)`).run().lastInsertRowid;
    expect(modules.isEnabled('branches')).toBe(true);   // an upgrade never hides a working multi-branch setup
    db.prepare(`UPDATE stores SET is_active = 0 WHERE id = ?`).run(outletId);
    expect(modules.isEnabled('branches')).toBe(false);
    db.prepare(`UPDATE stores SET is_active = 1 WHERE id = ?`).run(outletId);
  });

  it('an explicit choice beats the default, either way', async () => {
    expect((await setBranches(admin, false)).body.data.branches).toBe(false);
    expect(modules.isEnabled('branches')).toBe(false);
    expect((await setBranches(admin, true)).body.data.branches).toBe(true);
    expect(modules.isEnabled('branches')).toBe(true);
  });
});

describe('with multi-branch mode OFF', () => {
  let manager;
  beforeAll(async () => {
    // Staff in the outlet, made while the mode is on.
    await setBranches(admin, true);
    outletStaffEmail = 'optional-outlet-cashier@urbantrends.com';
    db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'Outlet Cashier', ?, ?, 'cashier', 1)`)
      .run(outletId, outletStaffEmail, bcrypt.hashSync(PASSWORD, 10));
    db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'Opt Manager', 'optional-manager@urbantrends.com', ?, 'manager', 1)`)
      .run(mainId, bcrypt.hashSync(PASSWORD, 10));
    const login = await request(app).post('/api/auth/login').send({ email: 'optional-manager@urbantrends.com', password: PASSWORD });
    manager = login.body.token;
    expect((await setBranches(admin, false)).status).toBe(200);
  });

  it('closes adding and editing branches', async () => {
    const create = await request(app).post('/api/stores').set(auth(admin)).send({ name: 'Should Not Exist' });
    expect(create.status).toBe(404);
    expect(create.body.code || create.body.error?.code).toBe('MODULE_DISABLED');
    expect((await request(app).put(`/api/stores/${outletId}`).set(auth(admin)).send({ name: 'Renamed' })).status).toBe(404);
    expect(db.prepare(`SELECT COUNT(*) c FROM stores WHERE name = 'Should Not Exist'`).get().c).toBe(0);
  });

  it('still lists branches, so the current branch name is available', async () => {
    const list = await get('/api/stores', manager);
    expect(list.status).toBe(200);
    expect(list.body.data.some((s) => s.is_current && s.id === mainId)).toBe(true);
  });

  it('closes transfers and the branch comparison report', async () => {
    for (const path of ['/api/stock/transfers', '/api/reports/branch-comparison']) {
      const res = await get(path, admin);
      expect(res.status).toBe(404);
    }
    expect((await request(app).post('/api/stock/transfers').set(auth(admin)).send({})).status).toBe(404);
    expect((await get('/api/reports/export/branches?format=xlsx', admin)).status).toBe(404);
  });

  it('keeps the P&L export working, without its branch table', async () => {
    const res = await get('/api/reports/pnl', admin);
    expect(res.status).toBe(200);
    expect(res.body.data.byBranch.rows.map((r) => r.store_id)).toEqual([mainId]);   // one row: this shop
    const doc = require('../src/services/reportDocuments.service').build('pnl', { user: { storeId: mainId, role: 'admin' }, from: '2026-01-01', to: '2026-01-31' });
    expect(doc.sections.map((s) => s.heading)).not.toContain('Branch comparison');
    expect((await get('/api/reports/export/pnl?format=xlsx', admin)).status).toBe(200);
  });

  it('ignores a store_id that names another branch', async () => {
    // Stock lists stay on the caller's own branch even for someone who could normally look at another.
    const counts = await get(`/api/stock/counts?store_id=${outletId}`, manager);
    expect(counts.status).toBe(200);
    const staff = await get(`/api/staff?store_id=${outletId}&limit=100`, admin);
    expect(staff.status).toBe(200);
    expect(staff.body.data.every((u) => u.email !== outletStaffEmail)).toBe(true);
    const created = await request(app).post('/api/staff').set(auth(admin))
      .send({ name: 'Optional New', email: 'optional-new@urbantrends.com', phone: '0700000999', password: 'Passw0rd!long', role: 'cashier', store_id: outletId });
    expect(created.status).toBe(201);
    expect(db.prepare('SELECT store_id FROM users WHERE email = ?').get('optional-new@urbantrends.com').store_id).toBe(mainId);
  });

  it('switching back on restores everything, untouched', async () => {
    expect((await setBranches(admin, true)).status).toBe(200);
    expect((await get('/api/stock/transfers', admin)).status).toBe(200);
    expect((await get('/api/reports/branch-comparison', admin)).status).toBe(200);
    const staff = await get(`/api/staff?store_id=${outletId}&limit=100`, admin);
    expect(staff.body.data.some((u) => u.email === outletStaffEmail)).toBe(true);
  });
});
