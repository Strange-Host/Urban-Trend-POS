const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const push = require('../src/services/push.service');
const notifications = require('../src/services/notifications.service');

afterAll(() => cleanupTestDb());

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const PASSWORD = 'Passw0rd!Passw0rd';
let ipN = 0;
const ip = () => { ipN += 1; return `10.55.${Math.floor(ipN / 250)}.${(ipN % 250) + 1}`; };
let admin; let storeId; let product; let seq = 0;

// A person signed in on a phone that has registered a push token.
async function phoneUser(role, { token = `tok-${role}-${Math.random().toString(36).slice(2, 9)}`, registerToken = true } = {}) {
  seq += 1;
  const email = `push${seq}-${role}@example.com`;
  const id = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, ?, ?, ?, ?, 1)`)
    .run(storeId, `Push ${role} ${seq}`, email, bcrypt.hashSync(PASSWORD, 4), role).lastInsertRowid;
  const login = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip())
    .send({ email, password: PASSWORD, device: { deviceId: `push-install-${seq}`, name: 'Test phone' } });
  expect(login.status).toBe(200);
  if (registerToken) expect((await request(app).post('/api/v1/devices').set(auth(login.body.token)).send({ pushToken: token })).status).toBe(200);
  return { id, email, token, jwt: login.body.token, sid: login.body.session.id, name: `Push ${role} ${seq}` };
}

function fakeProvider(impl) {
  const provider = { name: 'fake', send: vi.fn(impl || (async () => ({ ok: true }))) };
  push.setProvider(provider);
  return provider;
}
const settle = () => new Promise((r) => setTimeout(r, 40));            // lets the fire-and-forget push finish

beforeAll(async () => {
  admin = { token: await loginAsAdmin() };
  admin.id = db.prepare(`SELECT id FROM users WHERE email = 'admin@urbantrends.com'`).get().id;
  storeId = db.prepare('SELECT store_id FROM users WHERE id = ?').get(admin.id).store_id;
  product = db.prepare(`SELECT p.id, p.sell_price FROM products p WHERE p.is_active = 1 AND p.approval_status = 'approved' LIMIT 1`).get();
  db.prepare('UPDATE inventory SET quantity = quantity + 100 WHERE product_id = ? AND store_id = ?').run(product.id, storeId);
});
afterEach(() => push.resetForTests());

describe('what deserves a push', () => {
  it.each([
    ['approval_requested', 'warning', true],
    ['expense_pending', 'info', true],
    ['petty_cash_topup_pending', 'info', true],
    ['stock_transfer_pending', 'info', true],
    ['product_proposed', 'info', true],
    ['damaged_return', 'urgent', true],               // anything urgent
    ['security', 'warning', true],                    // new phone, big refund, price dropped
    ['security', 'urgent', true],
    ['security', 'info', false],                      // a new staff account is for the bell
    ['approval_decided', 'info', false],              // an outcome, not a decision
    ['low_stock', 'info', false],
    ['lead_assigned', 'info', false],
    ['unmatched_payment', 'warning', false],          // pushed by the "older than an hour" trigger, not on arrival
    ['online_order', 'info', false],
    ['shift_note', 'info', false],
  ])('%s (%s) -> %s', (type, severity, expected) => {
    expect(push.shouldPush({ type, severity })).toBe(expected);
  });
});

describe('with no Firebase account configured', () => {
  it('is a quiet no-op: nothing throws, notifications still reach the bell', async () => {
    delete process.env.FCM_SERVICE_ACCOUNT_JSON; delete process.env.FCM_SERVICE_ACCOUNT_FILE;
    push.resetForTests();
    expect(push.isConfigured()).toBe(false);
    const u = await phoneUser('manager');
    expect(await push.sendToUsers({ userIds: [u.id], title: 'x' })).toMatchObject({ sent: 0, skipped: 'not_configured' });
    const made = notifications.notify({ storeId, userIds: [u.id], type: 'approval_requested', severity: 'warning', title: 'Needs you' });
    expect(made).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(u.id).n).toBe(1);
  });

  it('an unreadable service account turns pushes off and never logs the key', async () => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = '{"private_key":"-----BEGIN SECRET-----shh","client_email":"a@b"}';
    push.resetForTests();
    const logger = require('../src/utils/logger');
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      expect(push.isConfigured()).toBe(false);
      expect(spy).toHaveBeenCalled();
      expect(JSON.stringify(spy.mock.calls)).not.toContain('shh');
    } finally { spy.mockRestore(); delete process.env.FCM_SERVICE_ACCOUNT_JSON; push.resetForTests(); }
  });
});

describe('fan-out from notify()', () => {
  it('pushes a decision to the phones of the people it was addressed to, with what the app needs to open it', async () => {
    const provider = fakeProvider();
    const u = await phoneUser('manager');
    notifications.notify({ storeId, userIds: [u.id], type: 'approval_requested', severity: 'warning', title: 'Wanjiru asked to void sale S-9 (KES 500)', body: 'Wrong item', entityType: 'approval', entityId: 77 });
    await settle();
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(provider.send.mock.calls[0][0]).toMatchObject({
      token: u.token, title: 'Wanjiru asked to void sale S-9 (KES 500)', body: 'Wrong item',
      data: { kind: 'approval_requested', severity: 'warning', entityType: 'approval', entityId: '77', link: 'approval:77' },
    });
    expect(typeof provider.send.mock.calls[0][0].data.id).toBe('string');
    for (const v of Object.values(provider.send.mock.calls[0][0].data)) expect(typeof v).toBe('string');   // FCM requires strings
  });

  it('end to end: a cashier asking for a void buzzes the manager\'s phone but not the cashier\'s', async () => {
    const provider = fakeProvider();
    const manager = await phoneUser('manager');
    const cashier = await phoneUser('cashier');
    const sale = await request(app).post('/api/sales').set(auth(cashier.jwt))
      .send({ items: [{ product_id: product.id, quantity: 1 }], payments: [{ method: 'cash', amount: product.sell_price }] });
    expect(sale.status).toBe(201);
    const filed = await request(app).post('/api/approvals').set(auth(cashier.jwt)).send({ kind: 'void_sale', sale_id: sale.body.data.id, reason: 'Wrong item' });
    expect(filed.status).toBe(201);
    await settle();
    const tokens = provider.send.mock.calls.map((c) => c[0].token);
    expect(tokens).toContain(manager.token);
    expect(tokens).not.toContain(cashier.token);
    expect(provider.send.mock.calls.find((c) => c[0].token === manager.token)[0].title).toContain(cashier.name);
  });

  it('does not push informational notifications', async () => {
    const provider = fakeProvider();
    const u = await phoneUser('manager');
    notifications.notify({ storeId, userIds: [u.id], type: 'low_stock', severity: 'info', title: 'Low stock' });
    notifications.notify({ storeId, userIds: [u.id], type: 'approval_decided', severity: 'info', title: 'Approved' });
    await settle();
    expect(provider.send).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(u.id).n).toBe(2);   // still in the bell
  });

  it('does not buzz twice for a de-duplicated notification', async () => {
    const provider = fakeProvider();
    const u = await phoneUser('manager');
    const args = { storeId, userIds: [u.id], type: 'expense_pending', title: 'Expense waiting', dedupeKey: `dedupe-${u.id}` };
    expect(notifications.notify(args)).toBe(1);
    expect(notifications.notify(args)).toBe(0);
    await settle();
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it('reaches every phone a person is signed in on, and none that are signed out, switched off or never registered', async () => {
    const provider = fakeProvider();
    const u = await phoneUser('manager', { token: 'phone-one' });
    const second = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip()).send({ email: u.email, password: PASSWORD, device: { deviceId: 'second-phone' } });
    await request(app).post('/api/v1/devices').set(auth(second.body.token)).send({ pushToken: 'phone-two' });
    const third = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip()).send({ email: u.email, password: PASSWORD, device: { deviceId: 'third-phone' } });
    await request(app).post('/api/v1/devices').set(auth(third.body.token)).send({ pushToken: 'phone-three' });
    await request(app).post('/api/v1/devices').set(auth(third.body.token)).send({ pushToken: null });                       // switched off
    const fourth = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip()).send({ email: u.email, password: PASSWORD, device: { deviceId: 'fourth-phone' } });
    await request(app).post('/api/v1/devices').set(auth(fourth.body.token)).send({ pushToken: 'phone-four' });
    await request(app).delete(`/api/v1/devices/${fourth.body.session.id}`).set(auth(admin.token));                           // signed out
    await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip()).send({ email: u.email, password: PASSWORD });  // never registered

    notifications.notify({ storeId, userIds: [u.id], type: 'stock_transfer_pending', title: 'Transfer waiting' });
    await settle();
    expect(provider.send.mock.calls.map((c) => c[0].token).sort()).toEqual(['phone-one', 'phone-two']);
  });

  it('wipes a token the provider says is dead and leaves the others alone', async () => {
    const u = await phoneUser('manager', { token: 'dead-token' });
    const other = await phoneUser('manager', { token: 'healthy-token' });
    const provider = fakeProvider(async ({ token }) => (token === 'dead-token' ? { ok: false, invalidToken: true, error: '404 UNREGISTERED' } : { ok: true }));
    notifications.notify({ storeId, userIds: [u.id, other.id], type: 'approval_requested', severity: 'warning', title: 'Decide' });
    await settle();
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(db.prepare('SELECT push_token FROM auth_sessions WHERE id = ?').get(u.sid).push_token).toBeNull();
    expect(db.prepare('SELECT push_token FROM auth_sessions WHERE id = ?').get(other.sid).push_token).toBe('healthy-token');
    expect(db.prepare('SELECT revoked_at FROM auth_sessions WHERE id = ?').get(u.sid).revoked_at).toBeNull();   // the sign-in itself survives
  });

  it('keeps a token when the failure is only temporary, and never logs it', async () => {
    const u = await phoneUser('manager', { token: 'flaky-token-SECRET' });
    fakeProvider(async () => ({ ok: false, error: '503 UNAVAILABLE' }));
    const logger = require('../src/utils/logger');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      notifications.notify({ storeId, userIds: [u.id], type: 'approval_requested', severity: 'warning', title: 'Decide' });
      await settle();
      expect(db.prepare('SELECT push_token FROM auth_sessions WHERE id = ?').get(u.sid).push_token).toBe('flaky-token-SECRET');
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
    } finally { warn.mockRestore(); }
  });

  it('a provider that throws can never break the notification, nor the action behind it', async () => {
    const u = await phoneUser('manager');
    fakeProvider(async () => { throw new Error('Firebase is down'); });
    let made;
    expect(() => { made = notifications.notify({ storeId, userIds: [u.id], type: 'approval_requested', severity: 'warning', title: 'Decide' }); }).not.toThrow();
    await settle();
    expect(made).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?').get(u.id).n).toBe(1);
  });

  it('pushes urgent security alerts, and a new phone signing in, to the admins\' phones', async () => {
    const provider = fakeProvider();
    const owner = await phoneUser('admin', { token: 'owner-phone' });
    const staff = await phoneUser('cashier');                                  // first sign-in of an unseen install: "new phone" alert
    await settle();
    const alert = provider.send.mock.calls.map((c) => c[0]).find((m) => m.token === 'owner-phone' && m.title === `${staff.name} signed in on a new phone`);
    expect(alert).toBeTruthy();
    expect(alert.data).toMatchObject({ kind: 'security', severity: 'warning' });
    expect(provider.send.mock.calls.every((c) => c[0].token !== staff.token)).toBe(true);   // not the cashier's own phone
  });

  it('the person who caused a security event does not get a push about themselves', async () => {
    const provider = fakeProvider();
    const owner = await phoneUser('admin', { token: 'owner-self' });
    const before = provider.send.mock.calls.length;
    const securityAlerts = require('../src/services/securityAlerts.service');
    securityAlerts.raise({ storeId, type: 'credentials_changed', severity: 'warning', title: 'Credentials changed by the owner', actorId: owner.id });
    await settle();
    expect(provider.send.mock.calls.slice(before).map((c) => c[0].token)).not.toContain('owner-self');
  });
});

describe('the Firebase client', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = {
    type: 'service_account', project_id: 'urban-trends-test', client_email: 'push@urban-trends-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token',
  };
  let post;
  beforeEach(() => {
    process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify(account);
    push.resetForTests();
    post = vi.spyOn(axios, 'post').mockImplementation(async (url) => {
      if (url === account.token_uri) return { data: { access_token: 'google-access-token', expires_in: 3600 } };
      return { data: { name: 'projects/urban-trends-test/messages/1' } };
    });
  });
  afterEach(() => { post.mockRestore(); delete process.env.FCM_SERVICE_ACCOUNT_JSON; push.resetForTests(); });
  // Signing a test user in is itself a "new phone" event that pushes to any admin phone left over from earlier tests - the
  // feature working. Let that finish and start from a clean client, so each test measures only its own calls.
  const quiet = async () => { await settle(); push.resetForTests(); post.mockClear(); };

  it('signs a short-lived assertion with the service account key, then sends with the access token it was given', async () => {
    expect(push.isConfigured()).toBe(true);
    const u = await phoneUser('manager', { token: 'real-device-token' });
    await quiet();
    const r = await push.sendToUsers({ userIds: [u.id], title: 'Approve a void', body: 'KES 500', data: { link: 'approval:5', n: 5, skipped: null } });
    expect(r).toMatchObject({ sent: 1, failed: 0, removed: 0 });

    const [tokenUrl, form] = post.mock.calls[0];
    expect(tokenUrl).toBe(account.token_uri);
    const params = new URLSearchParams(form);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const claims = jwt.verify(params.get('assertion'), publicKey, { algorithms: ['RS256'] });   // genuinely signed with the account's key
    expect(claims).toMatchObject({ iss: account.client_email, aud: account.token_uri, scope: 'https://www.googleapis.com/auth/firebase.messaging' });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(3600);

    const [sendUrl, payload, config] = post.mock.calls[1];
    expect(sendUrl).toBe('https://fcm.googleapis.com/v1/projects/urban-trends-test/messages:send');
    expect(config.headers.Authorization).toBe('Bearer google-access-token');
    expect(payload.message).toMatchObject({
      token: 'real-device-token', notification: { title: 'Approve a void', body: 'KES 500' },
      data: { link: 'approval:5', n: '5' }, android: { priority: 'HIGH' },
    });
    expect(payload.message.data).not.toHaveProperty('skipped');                   // null values are dropped, not sent as "null"
    expect(config.timeout).toBeGreaterThan(0);
  });

  it('reuses the access token between sends instead of asking Google every time', async () => {
    const u = await phoneUser('manager', { token: 'tok-reuse-1' });
    await quiet();
    await push.sendToUsers({ userIds: [u.id], title: 'one' });
    await push.sendToUsers({ userIds: [u.id], title: 'two' });
    expect(post.mock.calls.filter(([url]) => url === account.token_uri)).toHaveLength(1);
    expect(post.mock.calls.filter(([url]) => url.includes('messages:send'))).toHaveLength(2);
  });

  it('treats Google\'s "UNREGISTERED" / 404 as a dead token, but a 500 as temporary', async () => {
    const dead = await phoneUser('manager', { token: 'gone-token' });
    const flaky = await phoneUser('manager', { token: 'flaky-token' });
    await quiet();
    post.mockImplementation(async (url, body) => {
      if (url === account.token_uri) return { data: { access_token: 'a', expires_in: 3600 } };
      if (body.message.token === 'gone-token') { const e = new Error('nf'); e.response = { status: 404, data: { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } } }; throw e; }
      const e = new Error('boom'); e.response = { status: 500, data: { error: { status: 'INTERNAL' } } }; throw e;
    });
    const r = await push.sendToUsers({ userIds: [dead.id, flaky.id], title: 'x' });
    expect(r).toMatchObject({ sent: 0, failed: 2, removed: 1 });
    expect(db.prepare('SELECT push_token FROM auth_sessions WHERE id = ?').get(dead.sid).push_token).toBeNull();
    expect(db.prepare('SELECT push_token FROM auth_sessions WHERE id = ?').get(flaky.sid).push_token).toBe('flaky-token');
  });

  it('fetches a fresh access token after Google rejects the cached one', async () => {
    const u = await phoneUser('manager', { token: 'tok-stale-1' });
    await quiet();
    await push.sendToUsers({ userIds: [u.id], title: 'one' });
    let first = true;
    post.mockImplementation(async (url) => {
      if (url === account.token_uri) return { data: { access_token: 'fresh', expires_in: 3600 } };
      if (first) { first = false; const e = new Error('unauth'); e.response = { status: 401, data: {} }; throw e; }
      return { data: {} };
    });
    await push.sendToUsers({ userIds: [u.id], title: 'two' });          // gets the 401
    post.mockClear();
    await push.sendToUsers({ userIds: [u.id], title: 'three' });
    expect(post.mock.calls[0][0]).toBe(account.token_uri);              // went back to Google for a new token
  });
});
