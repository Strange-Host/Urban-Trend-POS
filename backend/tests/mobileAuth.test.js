const bcrypt = require('bcryptjs');
const { app, request, extractRefreshCookie, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const devicesService = require('../src/services/devices.service');

afterAll(() => cleanupTestDb());

const PW = 'Sturdy-Pelican-47';
let n = 0;
let ipN = 0;
const ip = () => { ipN += 1; return `10.77.${Math.floor(ipN / 250)}.${(ipN % 250) + 1}`; };   // each request gets its own address (login rate limit)
const auth = (t) => ({ Authorization: `Bearer ${t}` });

function makeUser({ role = 'cashier' } = {}) {
  n += 1;
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get().id;
  const id = db.prepare(`INSERT INTO users (store_id, name, email, phone, password_hash, role, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)`).run(store, `Mobile Tester ${n}`, `mobile${n}@example.com`, `07220000${String(n).padStart(2, '0')}`, bcrypt.hashSync(PW, 4), role).lastInsertRowid;
  return { id, email: `mobile${n}@example.com` };
}

const phone = (extra = {}) => ({ deviceId: `install-${Math.random().toString(36).slice(2)}`, name: 'Tecno Spark 10', platform: 'android 13', appVersion: '1.0.0', ...extra });

async function mobileLogin(email, device = phone(), password = PW) {
  const res = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip()).send({ email, password, device });
  return { res, token: res.body.token, refreshToken: res.body.refreshToken, sid: res.body.session?.id, device };
}
async function webLogin(email, password = PW) {
  const res = await request(app).post('/api/auth/login').set('X-Forwarded-For', ip()).send({ email, password });
  return { res, token: res.body.token, cookie: extractRefreshCookie(res), sid: res.body.session?.id };
}
const adminLogin = () => webLogin('admin@urbantrends.com', 'ChangeMe123!');
const refresh = (refreshToken) => request(app).post('/api/v1/auth/mobile/refresh').send({ refreshToken });
const agoIso = (ms) => new Date(Date.now() - ms).toISOString();

describe('mobile login', () => {
  it('returns the refresh token in the body, sets no cookie, and records a mobile device session', async () => {
    const u = makeUser();
    const { res, sid, device } = await mobileLogin(u.email);
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.refreshToken).toMatch(/^[0-9a-f]{80}$/);
    expect(res.body.user.email).toBe(u.email);
    expect(res.body.user.password_hash).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();

    const row = db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(sid);
    expect(row).toMatchObject({ client: 'mobile', device_id: device.deviceId, device_name: 'Tecno Spark 10', platform: 'android 13', app_version: '1.0.0', remember: 1 });
  });

  it('rejects a wrong password and an unknown email the same way, and counts towards the account lockout', async () => {
    const u = makeUser();
    const wrong = await mobileLogin(u.email, phone(), 'Not-The-Password-1');
    const unknown = await mobileLogin('nobody@example.com');
    expect(wrong.res.status).toBe(401);
    expect(unknown.res.status).toBe(401);
    expect(wrong.res.body.error.message).toBe(unknown.res.body.error.message);
    expect(db.prepare('SELECT failed_login_count AS c FROM users WHERE id = ?').get(u.id).c).toBe(1);
  });

  it('validates the body and ignores fields it does not know (a newer app must not break sign-in)', async () => {
    const bad = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip()).send({ email: 'a@b.c' });
    expect(bad.status).toBe(400);
    const u = makeUser();
    const ok = await request(app).post('/api/v1/auth/mobile/login').set('X-Forwarded-For', ip())
      .send({ email: u.email, password: PW, someFutureField: { x: 1 }, device: { name: 'Pixel', brandNewThing: true } });
    expect(ok.status).toBe(200);
  });

  it('a deactivated account cannot sign in', async () => {
    const u = makeUser();
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(u.id);
    expect((await mobileLogin(u.email)).res.status).toBe(401);
  });

  it('the access token works on the existing API', async () => {
    const u = makeUser();
    const { token } = await mobileLogin(u.email);
    const me = await request(app).get('/api/auth/me').set(auth(token));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(u.email);
  });
});

describe('mobile refresh and logout', () => {
  it('rotates the refresh token in the body, and the new access token works', async () => {
    const u = makeUser();
    const { refreshToken } = await mobileLogin(u.email);
    const r = await refresh(refreshToken);
    expect(r.status).toBe(200);
    expect(r.body.refreshToken).toMatch(/^[0-9a-f]{80}$/);
    expect(r.body.refreshToken).not.toBe(refreshToken);
    expect((await request(app).get('/api/auth/me').set(auth(r.body.token))).status).toBe(200);
  });

  it('a used refresh token is rejected; replaying it after the grace period ends the whole session', async () => {
    const u = makeUser();
    const { refreshToken, sid } = await mobileLogin(u.email);
    const first = await refresh(refreshToken);
    expect(first.status).toBe(200);

    // Straight away: refused, but could just be a retry after a dropped connection, so the session survives.
    expect((await refresh(refreshToken)).status).toBe(401);
    expect(db.prepare('SELECT revoked_at FROM auth_sessions WHERE id = ?').get(sid).revoked_at).toBeNull();
    expect((await refresh(first.body.refreshToken)).status).toBe(200);

    // Long after the swap it can only be a stolen copy: the session dies and the owner is alerted.
    db.prepare(`UPDATE refresh_tokens SET revoked_at = datetime('now', '-5 minutes') WHERE token_hash IS NOT NULL AND session_id = ? AND replaced_by_id IS NOT NULL`).run(sid);
    expect((await refresh(refreshToken)).status).toBe(401);
    expect(db.prepare('SELECT revoked_reason AS r FROM auth_sessions WHERE id = ?').get(sid).r).toBe('token_reuse');
    expect(db.prepare(`SELECT 1 FROM security_events WHERE type = 'session_reuse' AND subject_id = ?`).get(u.id)).toBeTruthy();
  });

  it('rejects an empty body, a garbage token and a missing token', async () => {
    expect((await request(app).post('/api/v1/auth/mobile/refresh').send({})).status).toBe(400);
    expect((await refresh('not-a-real-token')).status).toBe(401);
  });

  it('a browser cookie token cannot be used on the mobile door, nor a phone token on the web one', async () => {
    const u = makeUser();
    const web = await webLogin(u.email);
    const raw = web.cookie.split('=')[1];
    expect((await refresh(raw)).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', web.cookie)).status).toBe(200);   // the wrong-door try did not burn it

    const mob = await mobileLogin(u.email);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', `ut_refresh_token=${mob.refreshToken}`)).status).toBe(401);
    expect((await refresh(mob.refreshToken)).status).toBe(200);                                          // and neither did this one
  });

  it('logout kills the refresh token and the access token, and never errors', async () => {
    const u = makeUser();
    const { refreshToken, token } = await mobileLogin(u.email);
    expect((await request(app).post('/api/v1/auth/mobile/logout').send({ refreshToken })).status).toBe(204);
    expect((await refresh(refreshToken)).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(auth(token))).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/mobile/logout').send({ refreshToken: 'unknown' })).status).toBe(204);
  });
});

describe('mobile sessions are not locked or expired by idling', () => {
  it('stays signed in after a day without use (the phone locks itself with biometrics)', async () => {
    const u = makeUser();
    const { token, sid } = await mobileLogin(u.email);
    db.prepare('UPDATE auth_sessions SET last_activity_at = ? WHERE id = ?').run(agoIso(24 * 3600 * 1000 - 1000), sid);
    expect((await request(app).get('/api/auth/me').set(auth(token))).status).toBe(200);
  });

  it('but still ends at its hard maximum', async () => {
    const u = makeUser();
    const { token, sid } = await mobileLogin(u.email);
    db.prepare('UPDATE auth_sessions SET absolute_expires_at = ? WHERE id = ?').run(agoIso(1000), sid);
    const res = await request(app).get('/api/auth/me').set(auth(token));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('even a plain read refreshes "last seen"', async () => {
    const u = makeUser();
    const { token, sid } = await mobileLogin(u.email);
    db.prepare('UPDATE auth_sessions SET last_activity_at = ? WHERE id = ?').run(agoIso(10 * 60 * 1000), sid);
    await request(app).get('/api/auth/me').set(auth(token));
    const seen = Date.parse(db.prepare('SELECT last_activity_at AS t FROM auth_sessions WHERE id = ?').get(sid).t);
    expect(Date.now() - seen).toBeLessThan(60 * 1000);
  });
});

describe('device registration and push tokens', () => {
  it('registers a push token and updates the device details', async () => {
    const u = makeUser();
    const { token, sid } = await mobileLogin(u.email);
    const res = await request(app).post('/api/v1/devices').set(auth(token)).send({ name: 'Kitchen phone', appVersion: '1.0.1', pushToken: 'fcm-token-A' });
    expect(res.status).toBe(200);
    expect(res.body.device).toMatchObject({ id: sid, name: 'Kitchen phone', appVersion: '1.0.1', current: true, pushEnabled: true });
    expect(res.body.device.pushToken).toBeUndefined();                     // the token itself is never sent back
    expect(db.prepare('SELECT push_token FROM auth_sessions WHERE id = ?').get(sid).push_token).toBe('fcm-token-A');
    expect(db.prepare('SELECT platform FROM auth_sessions WHERE id = ?').get(sid).platform).toBe('android 13');   // fields not sent are kept
  });

  it('pushToken: null switches push off for that phone', async () => {
    const u = makeUser();
    const { token, sid } = await mobileLogin(u.email);
    await request(app).post('/api/v1/devices').set(auth(token)).send({ pushToken: 'fcm-token-B' });
    const res = await request(app).post('/api/v1/devices').set(auth(token)).send({ pushToken: null });
    expect(res.body.device.pushEnabled).toBe(false);
    expect(db.prepare('SELECT push_token FROM auth_sessions WHERE id = ?').get(sid).push_token).toBeNull();
  });

  it('a push token follows the phone: signing in as someone else on it stops the old owner receiving pushes', async () => {
    const a = makeUser();
    const b = makeUser();
    const first = await mobileLogin(a.email);
    await request(app).post('/api/v1/devices').set(auth(first.token)).send({ pushToken: 'shared-phone-token' });
    const second = await mobileLogin(b.email);
    await request(app).post('/api/v1/devices').set(auth(second.token)).send({ pushToken: 'shared-phone-token' });
    expect(devicesService.pushTokensForUsers([a.id]).map((t) => t.token)).not.toContain('shared-phone-token');
    expect(devicesService.pushTokensForUsers([b.id]).map((t) => t.token)).toContain('shared-phone-token');
  });

  it('needs a signed-in mobile session: no token = 401, a web session = 403', async () => {
    expect((await request(app).post('/api/v1/devices').send({ pushToken: 'x' })).status).toBe(401);
    const u = makeUser();
    const web = await webLogin(u.email);
    const res = await request(app).post('/api/v1/devices').set(auth(web.token)).send({ pushToken: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MOBILE_ONLY');
  });

  it('lists only your own phones; web sessions are not in the list, and the web devices screen does not show phones', async () => {
    const u = makeUser();
    const other = makeUser();
    const mine = await mobileLogin(u.email);
    await mobileLogin(other.email);
    const web = await webLogin(u.email);

    const list = await request(app).get('/api/v1/devices').set(auth(mine.token));
    expect(list.body.devices.map((d) => d.id)).toEqual([mine.sid]);
    expect(list.body.devices[0].current).toBe(true);

    const webList = await request(app).get('/api/auth/sessions').set(auth(web.token));
    expect(webList.body.sessions.map((s) => s.id)).toEqual([web.sid]);
  });

  it('only an admin can list every phone in the business', async () => {
    const u = makeUser();
    const mine = await mobileLogin(u.email);
    expect((await request(app).get('/api/v1/devices?all=1').set(auth(mine.token))).status).toBe(403);

    const admin = await adminLogin();
    const all = await request(app).get('/api/v1/devices?all=1').set(auth(admin.token));
    expect(all.status).toBe(200);
    const found = all.body.devices.find((d) => d.id === mine.sid);
    expect(found.user).toEqual({ id: u.id, name: db.prepare('SELECT name FROM users WHERE id = ?').get(u.id).name });
  });
});

describe('revoking a device', () => {
  it('a revoked phone is signed out on its next request and cannot reuse its tokens', async () => {
    const u = makeUser();
    const phoneA = await mobileLogin(u.email);
    const phoneB = await mobileLogin(u.email);
    await request(app).post('/api/v1/devices').set(auth(phoneA.token)).send({ pushToken: 'revoked-phone-token' });

    const admin = await adminLogin();
    const res = await request(app).delete(`/api/v1/devices/${phoneA.sid}`).set(auth(admin.token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alreadyRevoked: false });

    const next = await request(app).get('/api/auth/me').set(auth(phoneA.token));
    expect(next.status).toBe(401);
    expect(next.body.error.code).toBe('SESSION_EXPIRED');
    expect((await refresh(phoneA.refreshToken)).status).toBe(401);

    // Pushes stop with it (the token is wiped, not just filtered out), and the user's other phone is untouched.
    expect(db.prepare('SELECT push_token FROM auth_sessions WHERE id = ?').get(phoneA.sid).push_token).toBeNull();
    expect(devicesService.pushTokensForUsers([u.id]).map((t) => t.token)).not.toContain('revoked-phone-token');
    expect((await request(app).get('/api/auth/me').set(auth(phoneB.token))).status).toBe(200);
    expect((await refresh(phoneB.refreshToken)).status).toBe(200);
  });

  it('is written to the activity log', async () => {
    const u = makeUser();
    const { sid } = await mobileLogin(u.email);
    const admin = await adminLogin();
    await request(app).delete(`/api/v1/devices/${sid}`).set(auth(admin.token));
    const log = db.prepare(`SELECT * FROM staff_logs WHERE entity_type = 'device_session' AND entity_id = ?`).get(sid);
    expect(log).toBeTruthy();
    expect(log.action).toBe('update');
  });

  it('people can sign out their own phone but not someone else\'s (404, same as an unknown id)', async () => {
    const a = makeUser();
    const b = makeUser();
    const phoneA = await mobileLogin(a.email);
    const phoneB = await mobileLogin(b.email);
    expect((await request(app).delete(`/api/v1/devices/${phoneB.sid}`).set(auth(phoneA.token))).status).toBe(404);
    expect((await request(app).delete('/api/v1/devices/999999').set(auth(phoneA.token))).status).toBe(404);
    expect((await request(app).get('/api/auth/me').set(auth(phoneB.token))).status).toBe(200);
    expect((await request(app).delete(`/api/v1/devices/${phoneA.sid}`).set(auth(phoneA.token))).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth(phoneA.token))).status).toBe(401);
  });

  it('a web session id is not a device: it cannot be revoked here', async () => {
    const u = makeUser();
    const web = await webLogin(u.email);
    const phoneU = await mobileLogin(u.email);
    expect((await request(app).delete(`/api/v1/devices/${web.sid}`).set(auth(phoneU.token))).status).toBe(404);
    expect((await request(app).get('/api/auth/me').set(auth(web.token))).status).toBe(200);
  });

  it('revoking twice is harmless', async () => {
    const u = makeUser();
    const { sid } = await mobileLogin(u.email);
    const admin = await adminLogin();
    await request(app).delete(`/api/v1/devices/${sid}`).set(auth(admin.token));
    const again = await request(app).delete(`/api/v1/devices/${sid}`).set(auth(admin.token));
    expect(again.status).toBe(200);
    expect(again.body.alreadyRevoked).toBe(true);
  });

  it('"sign out everywhere" from the website also signs out phones', async () => {
    const u = makeUser();
    const phoneU = await mobileLogin(u.email);
    const web = await webLogin(u.email);
    const res = await request(app).post('/api/auth/sessions/revoke-others').set(auth(web.token));
    expect(res.body.ended).toBeGreaterThanOrEqual(1);
    expect((await request(app).get('/api/auth/me').set(auth(phoneU.token))).status).toBe(401);
    expect((await refresh(phoneU.refreshToken)).status).toBe(401);
  });

  it('changing the password signs out every phone', async () => {
    const u = makeUser();
    const phoneU = await mobileLogin(u.email);
    const res = await request(app).post('/api/auth/change-password').set(auth(phoneU.token)).send({ currentPassword: PW, newPassword: 'Another-Sturdy-Heron-91' });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(auth(phoneU.token))).status).toBe(401);
    expect((await refresh(phoneU.refreshToken)).status).toBe(401);
  });

  it('deactivating a user signs out their phones', async () => {
    const u = makeUser();
    const phoneU = await mobileLogin(u.email);
    const admin = await adminLogin();
    await request(app).delete(`/api/staff/${u.id}`).set(auth(admin.token));
    expect((await request(app).get('/api/auth/me').set(auth(phoneU.token))).status).toBe(401);
    expect((await refresh(phoneU.refreshToken)).status).toBe(401);
  });
});

describe('new phone alert', () => {
  it('tells the admins the first time an install signs in, and not again for the same install', async () => {
    const u = makeUser();
    const install = phone({ deviceId: 'brand-new-install-1' });
    const countAlerts = () => db.prepare(`SELECT COUNT(*) AS c FROM security_events WHERE type = 'new_device_login' AND subject_id = ?`).get(u.id).c;
    await mobileLogin(u.email, install);
    expect(countAlerts()).toBe(1);
    await mobileLogin(u.email, install);
    expect(countAlerts()).toBe(1);
    await mobileLogin(u.email, phone({ deviceId: 'brand-new-install-2' }));
    expect(countAlerts()).toBe(2);

    const admin = db.prepare(`SELECT id FROM users WHERE email = 'admin@urbantrends.com'`).get();
    const name = db.prepare('SELECT name FROM users WHERE id = ?').get(u.id).name;
    expect(db.prepare(`SELECT 1 FROM notifications WHERE user_id = ? AND type = 'security' AND title = ?`).get(admin.id, `${name} signed in on a new phone`)).toBeTruthy();
  });
});

describe('existing web behaviour is unchanged', () => {
  it('a web session idle past the cashier lock time is still locked, and past the sign-out time still expires', async () => {
    const u = makeUser();
    const web = await webLogin(u.email);
    db.prepare('UPDATE auth_sessions SET last_activity_at = ? WHERE id = ?').run(agoIso(10 * 60 * 1000), web.sid);   // cashier locks after 5 min
    const locked = await request(app).get('/api/products').set(auth(web.token));
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('SESSION_LOCKED');

    db.prepare('UPDATE auth_sessions SET last_activity_at = ? WHERE id = ?').run(agoIso(60 * 60 * 1000), web.sid);   // signs out after 30 min
    const expired = await request(app).get('/api/products').set(auth(web.token));
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('SESSION_EXPIRED');
  });
});
