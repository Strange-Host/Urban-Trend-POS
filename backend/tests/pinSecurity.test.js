const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const bcrypt = require('bcryptjs');
const db = require('../src/config/db');
const { clearDefaultAdminPins } = require('../src/services/securityBaseline.service');
const { isWeakPin, assertValidPin } = require('../src/utils/pin');

afterAll(() => cleanupTestDb());

const auth = (t) => ({ Authorization: `Bearer ${t}` });
let adminToken;
let adminId;

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  adminId = db.prepare(`SELECT id FROM users WHERE email = 'admin@urbantrends.com'`).get().id;
});

describe('PIN strength rules', () => {
  it('flags obvious PINs and accepts ordinary ones', () => {
    ['1234', '4321', '0000', '1111', '777777', '2345', '9876', '123456', '2580'].forEach((p) => expect(isWeakPin(p)).toBe(true));
    ['4821', '7305', '190264', '1357'].forEach((p) => expect(isWeakPin(p)).toBe(false));
  });
  it('requires 4-6 digits', () => {
    ['12', 'abcd', '12 34', '1234567', 123456].forEach((p) => expect(() => assertValidPin(p)).toThrow());
    expect(() => assertValidPin(undefined)).not.toThrow();
    expect(() => assertValidPin('')).not.toThrow();
    expect(() => assertValidPin('4821')).not.toThrow();
  });
});

describe('the seeded admin has no default PIN', () => {
  it('is created without a PIN, and 1234 does not sign in', async () => {
    const row = db.prepare('SELECT pin_code_hash FROM users WHERE id = ?').get(adminId);
    expect(row.pin_code_hash).toBeNull();
    const res = await request(app).post('/api/auth/pin-login').send({ userId: adminId, pin: '1234' });
    expect(res.status).toBe(401);
  });
});

describe('installs seeded before the fix', () => {
  it('removes the default 1234 PIN from admin accounts on startup, and nothing else', () => {
    db.prepare('UPDATE users SET pin_code_hash = ? WHERE id = ?').run(bcrypt.hashSync('1234', 10), adminId);
    const cashier = db.prepare(`INSERT INTO users (store_id, name, email, phone, password_hash, pin_code_hash, role, is_active)
      VALUES (1, 'Legacy Cashier', 'legacy-cashier@urbantrends.com', '0700000050', 'x', ?, 'cashier', 1)`).run(bcrypt.hashSync('1234', 10)).lastInsertRowid;
    const otherAdmin = db.prepare(`INSERT INTO users (store_id, name, email, phone, password_hash, pin_code_hash, role, is_active)
      VALUES (1, 'Second Admin', 'second-admin@urbantrends.com', '0700000051', 'x', ?, 'admin', 1)`).run(bcrypt.hashSync('4821', 10)).lastInsertRowid;

    expect(clearDefaultAdminPins()).toBe(1);

    expect(db.prepare('SELECT pin_code_hash FROM users WHERE id = ?').get(adminId).pin_code_hash).toBeNull();
    // a different admin PIN and a cashier's PIN are not touched
    expect(db.prepare('SELECT pin_code_hash FROM users WHERE id = ?').get(otherAdmin).pin_code_hash).toBeTruthy();
    expect(db.prepare('SELECT pin_code_hash FROM users WHERE id = ?').get(cashier).pin_code_hash).toBeTruthy();
    // running it again changes nothing
    expect(clearDefaultAdminPins()).toBe(0);
  });
});

describe('staff PINs', () => {
  const base = { phone: '0700000060', password: 'Passw0rd!long', role: 'cashier' };

  it('refuses a weak or malformed PIN when creating or editing staff', async () => {
    for (const pin of ['1234', '0000', '99', 'abcd', '1234567']) {
      const res = await request(app).post('/api/staff').set(auth(adminToken))
        .send({ ...base, name: 'Weak Pin', email: `weak-${pin}@urbantrends.com`, pin });
      expect(res.status).toBe(400);
    }
    const ok = await request(app).post('/api/staff').set(auth(adminToken))
      .send({ ...base, name: 'Good Pin', email: 'good-pin@urbantrends.com', pin: '4821' });
    expect(ok.status).toBe(201);
    const bad = await request(app).patch(`/api/staff/${ok.body.data.id}`).set(auth(adminToken)).send({ pin: '1111' });
    expect(bad.status).toBe(400);
  });

  it('a cashier can use PIN login; a manager or admin cannot, even with a good PIN', async () => {
    const mk = async (role, n) => {
      const r = await request(app).post('/api/staff').set(auth(adminToken))
        .send({ ...base, phone: `07000001${n}`, name: `PIN ${role}`, email: `pin-${role}@urbantrends.com`, role, pin: '7305' });
      expect(r.status).toBe(201);
      return r.body.data.id;
    };
    const cashierId = await mk('cashier', 1);
    const managerId = await mk('manager', 2);

    const okRes = await request(app).post('/api/auth/pin-login').send({ userId: cashierId, pin: '7305' });
    expect(okRes.status).toBe(200);
    expect(okRes.body.token).toBeTruthy();

    const mgr = await request(app).post('/api/auth/pin-login').send({ userId: managerId, pin: '7305' });
    expect(mgr.status).toBe(403);
    expect(mgr.body.error.code).toBe('PIN_LOGIN_CASHIERS_ONLY');

    db.prepare('UPDATE users SET pin_code_hash = ? WHERE id = ?').run(bcrypt.hashSync('7305', 10), adminId);
    const adm = await request(app).post('/api/auth/pin-login').send({ userId: adminId, pin: '7305' });
    expect(adm.status).toBe(403);
  });
});
