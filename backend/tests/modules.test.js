const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const modules = require('../src/services/modules.service');

afterAll(() => cleanupTestDb());

const auth = (t) => ({ Authorization: `Bearer ${t}` });
let admin;
let managerToken;
let managerId;
let cashierToken;
let cashierId;
const setModules = (body) => request(app).put('/api/modules').set(auth(admin)).send(body);

beforeAll(async () => {
  admin = await loginAsAdmin();
  const mk = async (role, n) => {
    const r = await request(app).post('/api/staff').set(auth(admin))
      .send({ name: `Mod ${role}`, email: `mod-${role}@urbantrends.com`, phone: `07000002${n}`, password: 'Passw0rd!long', role });
    expect(r.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ email: `mod-${role}@urbantrends.com`, password: 'Passw0rd!long' });
    return { id: r.body.data.id, token: login.body.token };
  };
  ({ id: managerId, token: managerToken } = await mk('manager', 1));
  ({ id: cashierId, token: cashierToken } = await mk('cashier', 2));
});

describe('the switches', () => {
  it('are OFF when nothing has been saved', () => {
    db.prepare(`DELETE FROM settings WHERE key IN ('module_control_enabled', 'module_branches_enabled')`).run();
    // branches is derived while unset: off for a one-branch shop (this test database has one).
    expect(db.prepare('SELECT COUNT(*) c FROM stores WHERE is_active = 1').get().c).toBe(1);
    expect(modules.getAll()).toEqual({ control: false, branches: false });
  });

  it('any signed-in user can read them; only an admin can change them', async () => {
    expect((await request(app).get('/api/modules')).status).toBe(401);
    const asCashier = await request(app).get('/api/modules').set(auth(cashierToken));
    expect(asCashier.status).toBe(200);
    expect(asCashier.body.data).toEqual({ control: false, branches: false });
    expect((await request(app).put('/api/modules').set(auth(managerToken)).send({ control: true })).status).toBe(403);
    expect((await request(app).put('/api/modules').set(auth(cashierToken)).send({ control: true })).status).toBe(403);
  });

  it('validate the input, and cannot be flipped through the generic settings call', async () => {
    expect((await setModules({})).status).toBe(400);
    expect((await setModules({ control: 'yes' })).status).toBe(400);
    expect((await setModules({ banana: true })).status).toBe(400);
    const generic = await request(app).put('/api/settings').set(auth(admin)).send({ module_control_enabled: '1' });
    expect(generic.status).toBe(400);
    expect(modules.getAll().control).toBe(false);
  });

  it('can be set one at a time, and the change is audit-logged', async () => {
    const res = await setModules({ control: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ control: true, branches: false });
    const log = db.prepare(`SELECT COUNT(*) c FROM staff_logs WHERE entity_type = 'modules'`).get().c;
    expect(log).toBeGreaterThan(0);
    expect((await setModules({ control: false })).body.data).toEqual({ control: false, branches: false });
  });
});

describe('control extras switched off', () => {
  beforeAll(async () => { await setModules({ control: false }); });

  it('closes the screens that change permissions, two-factor and disputes', async () => {
    const calls = [
      request(app).get(`/api/staff/${cashierId}/permissions`).set(auth(admin)),
      request(app).put(`/api/staff/${cashierId}/permissions`).set(auth(admin)).send({ overrides: {} }),
      request(app).patch(`/api/staff/${cashierId}/two-factor`).set(auth(admin)).send({ enabled: true }),
      request(app).post('/api/orders/1/dispute').set(auth(admin)).send({ reason: 'x' }),
      request(app).post('/api/orders/1/dispute/resolve').set(auth(admin)).send({ outcome: 'closed' }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('MODULE_DISABLED');
    }
  });

  it('keeps enforcing an override that was set while the module was on', async () => {
    await setModules({ control: true });
    // managers can view reports by default; take it away from this one
    const set = await request(app).put(`/api/staff/${managerId}/permissions`).set(auth(admin)).send({ overrides: { 'reports.view': false } });
    expect(set.status).toBe(200);
    expect((await request(app).get('/api/reports/dashboard-overview').set(auth(managerToken))).status).toBe(403);

    await setModules({ control: false });
    // hiding the screen must not quietly hand the access back
    expect((await request(app).get('/api/reports/dashboard-overview').set(auth(managerToken))).status).toBe(403);
  });

  it('the core flows still work with everything off (till, orders, leads)', async () => {
    await setModules({ control: false });
    expect((await request(app).get('/api/products').set(auth(admin))).status).toBe(200);
    expect((await request(app).get('/api/orders').set(auth(admin))).status).toBe(200);
    expect((await request(app).get('/api/leads').set(auth(admin))).status).toBe(200);
    expect((await request(app).get('/api/reports/dashboard-overview').set(auth(admin))).status).toBe(200);
  });
});
