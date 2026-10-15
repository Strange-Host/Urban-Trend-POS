const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const zettatel = require('../src/config/zettatel');
const twoFactor = require('../src/services/twoFactor.service');

let adminToken;
let sendSpy;
let userId;
const EMAIL = 'twofa-user@urbantrends.com';
const PASSWORD = 'Passw0rd!Passw0rd';
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const lastCode = () => {
  const msg = sendSpy.mock.calls.at(-1)[0].message;
  return msg.match(/code: (\d{6})/)[1];
};
const challenge = (token) => db.prepare('SELECT * FROM otp_challenges WHERE token = ?').get(token);

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  userId = db.prepare(`INSERT INTO users (store_id, name, email, phone, password_hash, pin_code_hash, role, is_active) VALUES (?, 'TwoFA User', ?, '0722123456', ?, ?, 'manager', 1)`)
    .run(store.id, EMAIL, bcrypt.hashSync(PASSWORD, 10), bcrypt.hashSync('4321', 10)).lastInsertRowid;
  sendSpy = vi.spyOn(zettatel, 'sendSms');
});

afterAll(() => cleanupTestDb());

describe('two-factor — enabling', () => {
  it('refuses to enable without SMS credentials (it would lock the person out)', async () => {
    const res = await request(app).patch(`/api/staff/${userId}/two-factor`).set(auth(adminToken)).send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('SMS credentials');
  });

  it('refuses to enable for an account without a valid mobile number', async () => {
    await request(app).put('/api/sms/credentials').set(auth(adminToken)).send({ user_id: 'u', password: 'p', sender_id: 'UT' });
    const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
    const noPhone = db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'No Phone', 'nophone@urbantrends.com', ?, 'cashier', 1)`)
      .run(store.id, bcrypt.hashSync(PASSWORD, 10)).lastInsertRowid;
    const res = await request(app).patch(`/api/staff/${noPhone}/two-factor`).set(auth(adminToken)).send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('mobile number');
  });

  it('only admins can change it, and the body must be a boolean', async () => {
    const res = await request(app).patch(`/api/staff/${userId}/two-factor`).set(auth(adminToken)).send({ enabled: 'yes' });
    expect(res.status).toBe(400);
  });

  it('enables for a valid account', async () => {
    const res = await request(app).patch(`/api/staff/${userId}/two-factor`).set(auth(adminToken)).send({ enabled: true });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT two_factor_enabled FROM users WHERE id = ?').get(userId).two_factor_enabled).toBe(1);
  });
});

describe('two-factor — sign-in', () => {
  let challengeToken;

  it('a correct password yields a challenge and a text message — NOT a session', async () => {
    sendSpy.mockReset();
    sendSpy.mockResolvedValue({ ok: true, response: 'ok' });
    const res = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.twoFactorRequired).toBe(true);
    expect(res.body.token).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.phoneHint).toBe('25472****456');
    challengeToken = res.body.challengeToken;
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0].to).toBe('254722123456');
  });

  it('never stores the code in the clear or in the SMS outbox', () => {
    const code = lastCode();
    const row = challenge(challengeToken);
    expect(row.code_hmac).not.toContain(code);
    expect(row.code_hmac).toHaveLength(64);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM sms_outbox WHERE body LIKE ?`).get(`%${code}%`).n).toBe(0);
  });

  it('a wrong code is rejected with a generic message and counted', async () => {
    const wrong = lastCode() === '000000' ? '111111' : '000000';
    const res = await request(app).post('/api/auth/verify-otp').send({ challengeToken, code: wrong });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('OTP_INVALID');
    expect(challenge(challengeToken).attempts).toBe(1);
  });

  it('the right code signs you in, with a refresh cookie and permissions', async () => {
    const res = await request(app).post('/api/auth/verify-otp').send({ challengeToken, code: lastCode() });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe(EMAIL);
    expect(res.body.user.password_hash).toBeUndefined();
    expect(res.headers['set-cookie'].join(';')).toContain('ut_refresh_token');
  });

  it('a used code cannot be replayed', async () => {
    const res = await request(app).post('/api/auth/verify-otp').send({ challengeToken, code: lastCode() });
    expect(res.status).toBe(401);
  });

  it('PIN login is refused for an account with sign-in codes on', async () => {
    const res = await request(app).post('/api/auth/pin-login').send({ userId, pin: '4321' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PIN_LOGIN_DISABLED');
  });

  it('a wrong password never triggers a text message', async () => {
    sendSpy.mockClear();
    const res = await request(app).post('/api/auth/login').send({ email: EMAIL, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe('two-factor — limits and failure modes (service level)', () => {
  const user = () => db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const fresh = () => db.prepare('DELETE FROM otp_challenges WHERE user_id = ?').run(userId);

  beforeEach(() => { fresh(); sendSpy.mockReset(); sendSpy.mockResolvedValue({ ok: true, response: 'ok' }); });

  it('locks a challenge after 5 wrong guesses — even the right code then fails', async () => {
    const { challengeToken } = await twoFactor.start(user());
    const right = lastCode();
    const wrong = right === '123456' ? '654321' : '123456';
    for (let i = 0; i < twoFactor.MAX_ATTEMPTS; i++) {
      expect(() => twoFactor.verify({ challengeToken, code: wrong })).toThrow();
    }
    expect(() => twoFactor.verify({ challengeToken, code: right })).toThrow();
  });

  it('an expired code is rejected', async () => {
    const { challengeToken } = await twoFactor.start(user());
    db.prepare(`UPDATE otp_challenges SET expires_at = datetime('now', '-1 minute') WHERE token = ?`).run(challengeToken);
    expect(() => twoFactor.verify({ challengeToken, code: lastCode() })).toThrow(/invalid or has expired/);
  });

  it('an unknown challenge token is rejected with the same message', () => {
    expect(() => twoFactor.verify({ challengeToken: 'f'.repeat(48), code: '123456' })).toThrow(/invalid or has expired/);
  });

  it('if the SMS cannot be sent: 503, and the unsent code is dead', async () => {
    sendSpy.mockResolvedValue({ ok: false, error: 'HTTP 503' });
    await expect(twoFactor.start(user())).rejects.toMatchObject({ statusCode: 503, code: 'OTP_SEND_FAILED' });
    const row = db.prepare('SELECT * FROM otp_challenges WHERE user_id = ?').get(userId);
    expect(row.consumed_at).toBeTruthy();
  });

  it('resend: needs a cooldown, issues a NEW code that replaces the old, and is capped', async () => {
    const { challengeToken } = await twoFactor.start(user());
    const first = lastCode();
    await expect(twoFactor.resend({ challengeToken })).rejects.toMatchObject({ statusCode: 429 }); // too soon

    db.prepare(`UPDATE otp_challenges SET sent_at = datetime('now', '-60 seconds') WHERE token = ?`).run(challengeToken);
    await twoFactor.resend({ challengeToken });
    const second = lastCode();
    if (second !== first) expect(() => twoFactor.verify({ challengeToken, code: first })).toThrow(); // old code no longer valid

    for (let i = 1; i < 3; i++) {
      db.prepare(`UPDATE otp_challenges SET sent_at = datetime('now', '-60 seconds') WHERE token = ?`).run(challengeToken);
      await twoFactor.resend({ challengeToken });
    }
    db.prepare(`UPDATE otp_challenges SET sent_at = datetime('now', '-60 seconds') WHERE token = ?`).run(challengeToken);
    await expect(twoFactor.resend({ challengeToken })).rejects.toMatchObject({ statusCode: 429 }); // 4th resend refused
  });

  it('caps new challenges at 5 per hour per account', async () => {
    for (let i = 0; i < 5; i++) await twoFactor.start(user());
    await expect(twoFactor.start(user())).rejects.toMatchObject({ statusCode: 429 });
  });

  it('turning it off restores normal password login', async () => {
    fresh();
    const off = await request(app).patch(`/api/staff/${userId}/two-factor`).set(auth(adminToken)).send({ enabled: false });
    expect(off.status).toBe(200);
    const res = await request(app).post('/api/auth/login').send({ email: EMAIL, password: PASSWORD });
    expect(res.body.token).toBeTruthy();
    expect(res.body.twoFactorRequired).toBeUndefined();
  });
});
