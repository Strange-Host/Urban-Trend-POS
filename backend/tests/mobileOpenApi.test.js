const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const v1Router = require('../src/routes/v1');
const { ENDPOINTS, build } = require('../src/openapi/v1');
const res = require('../src/validation/mobile.responses');
const homeFeed = require('../src/services/homeFeed.service');

afterAll(() => cleanupTestDb());

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'Passw0rd!Passw0rd';
let ipN = 0;
const ip = () => { ipN += 1; return `10.99.${Math.floor(ipN / 250)}.${(ipN % 250) + 1}`; };

const schemaFor = (operationId, status) => ENDPOINTS.find((e) => e.operationId === operationId).responses[status].schema;
// Parses a real response with the documented schema; the failure message names exactly which field broke the contract.
function expectContract(operationId, status, response) {
  expect(response.status).toBe(status);
  const parsed = schemaFor(operationId, status).safeParse(response.body);
  if (!parsed.success) throw new Error(`${operationId} ${status} broke its documented shape: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`);
}

async function mobileUser(role) {
  const email = `oa-${role}-${Math.random().toString(36).slice(2, 7)}@example.com`;
  const storeId = db.prepare('SELECT id FROM stores LIMIT 1').get().id;
  const id = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(storeId, `OA ${role}`, email, bcrypt.hashSync(PASSWORD, 4), role).lastInsertRowid;
  const login = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip())
    .send({ email, password: PASSWORD, device: { deviceId: `oa-${id}`, name: 'Contract phone', platform: 'android 13', appVersion: '1.0.0' } });
  return { id, email, login };
}

describe('the OpenAPI document', () => {
  it('is public, valid-looking OpenAPI 3.1, and cacheable', async () => {
    const r = await request(app).get('/api/v1/openapi.json');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toMatch(/max-age/);
    expect(r.body.openapi).toBe('3.1.0');
    expect(r.body.servers).toEqual([{ url: '/api/v1' }]);
    expect(r.body.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(r.body).toEqual(JSON.parse(JSON.stringify(build())));
  });

  it('documents exactly the routes the router serves: an endpoint cannot ship undocumented, or be documented but missing', () => {
    const served = [];
    for (const layer of v1Router.stack) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) served.push(`${method} ${layer.route.path.replace(/:(\w+)/g, '{$1}')}`);
    }
    const documented = ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    expect(documented.sort()).toEqual(served.sort());
  });

  it('gives every operation a unique id, a security rule matching reality, and at least one response', () => {
    const ids = ENDPOINTS.map((e) => e.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const doc = build();
    for (const e of ENDPOINTS) {
      const op = doc.paths[e.path][e.method];
      expect(op.operationId).toBe(e.operationId);
      expect(op.security).toEqual(e.auth ? [{ bearerAuth: [] }] : []);
      expect(Object.keys(op.responses).length).toBeGreaterThan(0);
    }
  });

  it('is generated from the real request schemas: required fields and limits come through', () => {
    const body = build().paths['/auth/mobile/login'].post.requestBody.content['application/json'].schema;
    expect(body.required).toEqual(expect.arrayContaining(['email', 'password']));
    expect(body.properties.device.properties.deviceId.maxLength).toBe(100);
    const reg = build().paths['/devices'].post.requestBody.content['application/json'].schema;
    expect(reg.required ?? []).toEqual([]);                                                   // every field optional on POST /devices
    expect(JSON.stringify(reg.properties.pushToken)).toContain('null');                        // null switches pushes off
    expect(build().paths['/devices/{id}'].delete.parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
  });

  it('uses no $schema keyword inside the document (OpenAPI 3.1 sets the dialect once, at the top)', () => {
    expect(JSON.stringify(build())).not.toContain('"$schema"');
  });
});

describe('contract: real responses match the documented schemas', () => {
  let manager; let cashier; let admin;
  beforeAll(async () => {
    admin = { token: await loginAsAdmin() };
    manager = await mobileUser('manager');
    cashier = await mobileUser('cashier');
  });
  beforeEach(() => homeFeed.clearCache());

  it('sign-in, refresh and logout', async () => {
    expectContract('mobileLogin', 200, manager.login);
    const second = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip()).send({ email: manager.email, password: PASSWORD });
    expectContract('mobileLogin', 200, second);
    const refreshed = await request(app).post('/api/v1/auth/mobile/refresh').send({ refreshToken: second.body.refreshToken });
    expectContract('mobileRefresh', 200, refreshed);
    const out = await request(app).post('/api/v1/auth/mobile/logout').send({ refreshToken: refreshed.body.refreshToken });
    expect(out.status).toBe(204);
    expect(out.text).toBe('');
  });

  it('the sign-in-code challenge matches the other branch of the documented login response', async () => {
    const u = await mobileUser('cashier');
    db.prepare('UPDATE users SET two_factor_enabled = 1, phone = ? WHERE id = ?').run('0712345678', u.id);
    const smsService = require('../src/services/sms.service');
    const spy = vi.spyOn(smsService, 'sendNow').mockResolvedValue({ ok: true });
    try {
      const r = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip()).send({ email: u.email, password: PASSWORD });
      expectContract('mobileLogin', 200, r);
      expect(res.TwoFactorChallenge.safeParse(r.body).success).toBe(true);
      expect(res.MobileSession.safeParse(r.body).success).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it('errors use the one documented envelope', async () => {
    expectContract('mobileLogin', 401, await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip()).send({ email: manager.email, password: 'wrong-password-1' }));
    expectContract('mobileLogin', 400, await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip()).send({ email: 'x' }));
    expectContract('mobileRefresh', 401, await request(app).post('/api/v1/auth/mobile/refresh').send({ refreshToken: 'nope' }));
    expectContract('getHomeAttention', 401, await request(app).get('/api/v1/home/attention'));
    expectContract('listDevices', 403, await request(app).get('/api/v1/devices?all=1').set(auth(cashier.login.body.token)));
    expectContract('revokeDevice', 404, await request(app).delete('/api/v1/devices/999999').set(auth(cashier.login.body.token)));
  });

  it('app version, home and summary (both shapes)', async () => {
    expectContract('getAppVersion', 200, await request(app).get('/api/v1/app/version'));
    expectContract('getAppVersion', 200, await request(app).get('/api/v1/app/version?current=0.1.0'));
    expectContract('getHomeAttention', 200, await request(app).get('/api/v1/home/attention').set(auth(manager.login.body.token)));
    expectContract('getHomeAttention', 200, await request(app).get('/api/v1/home/attention').set(auth(cashier.login.body.token)));
    const shop = await request(app).get('/api/v1/home/summary').set(auth(manager.login.body.token));
    expectContract('getHomeSummary', 200, shop);
    expect(shop.body.scope).toBe('shop');
    const mine = await request(app).get('/api/v1/home/summary').set(auth(cashier.login.body.token));
    expectContract('getHomeSummary', 200, mine);
    expect(mine.body.scope).toBe('mine');
  });

  it('a populated attention list matches too (items, links, amounts)', async () => {
    const cat = db.prepare('SELECT id FROM expense_categories LIMIT 1').get().id;
    const storeId = db.prepare('SELECT id FROM stores LIMIT 1').get().id;
    db.prepare(`INSERT INTO expenses (store_id, category_id, amount, description, expense_date, recorded_by_staff_id, status)
      VALUES (?, ?, 75000, 'Contract expense', date('now'), ?, 'pending')`).run(storeId, cat, cashier.id);
    db.prepare(`INSERT INTO payment_notifications (store_id, source, method, amount, status, created_at)
      VALUES (?, 'mpesa', 'mobile_money', 120000, 'unmatched', datetime('now', '-3 hours'))`).run(storeId);
    const r = await request(app).get('/api/v1/home/attention').set(auth(manager.login.body.token));
    expectContract('getHomeAttention', 200, r);
    expect(r.body.items.length).toBeGreaterThan(1);
  });

  it('devices: register, list (own and everyone\'s), revoke', async () => {
    expectContract('registerDevice', 200, await request(app).post('/api/v1/devices').set(auth(manager.login.body.token)).send({ pushToken: 'contract-token' }));
    expectContract('listDevices', 200, await request(app).get('/api/v1/devices').set(auth(manager.login.body.token)));
    const all = await request(app).get('/api/v1/devices?all=1').set(auth(admin.token));
    expectContract('listDevices', 200, all);
    expect(all.body.devices.some((d) => d.user)).toBe(true);
    expectContract('revokeDevice', 200, await request(app).delete(`/api/v1/devices/${cashier.login.body.session.id}`).set(auth(admin.token)));
  });
});

describe('the contract guards the right thing', () => {
  const sample = { token: 't', refreshToken: 'r', user: { id: 1, name: 'A', email: 'a@b.c', role: 'admin', store_id: 1, permissions: [] }, session: { id: 1, expiresAt: new Date().toISOString() } };

  it('ADDING a field to a response is fine (an older app just ignores it)', () => {
    expect(res.MobileSession.safeParse({ ...sample, brandNewField: { nested: true }, user: { ...sample.user, avatarUrl: 'x' } }).success).toBe(true);
  });

  it('REMOVING or retyping a field is caught (that is what would break installed phones)', () => {
    const { refreshToken, ...missing } = sample;
    expect(res.MobileSession.safeParse(missing).success).toBe(false);
    expect(res.MobileSession.safeParse({ ...sample, session: { ...sample.session, id: 'one' } }).success).toBe(false);
    expect(res.Summary.safeParse({ scope: 'shop', generatedAt: 'x', date: 'x', currency: 'KES' }).success).toBe(false);
  });
});
