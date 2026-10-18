const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, extractRefreshCookie, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const { passwordProblems } = require('../src/utils/passwordPolicy');

afterAll(() => cleanupTestDb());

const PW = 'Sturdy-Pelican-47';
const MIN = 60 * 1000;
let n = 0;
let ipN = 0;
const ip = () => { ipN += 1; return `10.20.${Math.floor(ipN / 250)}.${(ipN % 250) + 1}`; };   // trust proxy: each request gets its own address

function makeUser({ role = 'cashier', pin = null } = {}) {
  n += 1;
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get().id;
  const id = db.prepare(`INSERT INTO users (store_id, name, email, phone, password_hash, pin_code_hash, role, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(store, `Session Tester ${n}`, `sess${n}@example.com`, `07110000${String(n).padStart(2, '0')}`,
    bcrypt.hashSync(PW, 4), pin ? bcrypt.hashSync(pin, 4) : null, role).lastInsertRowid;
  return { id, email: `sess${n}@example.com` };
}
async function signIn(email, extra = {}) {
  const res = await request(app).post('/api/auth/login').set('X-Forwarded-For', ip()).send({ email, password: PW, ...extra });
  return { res, token: res.body.token, cookie: extractRefreshCookie(res), sid: res.body.session?.id };
}
const age = (sid, field, msAgo) => db.prepare(`UPDATE auth_sessions SET ${field} = ? WHERE id = ?`).run(new Date(Date.now() - msAgo).toISOString(), sid);
const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('password policy', () => {
  it('asks admins and managers for 12+ characters and cashiers for 8+', () => {
    expect(passwordProblems('Short-1pw', { role: 'admin' }).length).toBeGreaterThan(0);
    expect(passwordProblems('Short-1pw', { role: 'cashier' })).toEqual([]);
    expect(passwordProblems('Bluefin-Lantern-84', { role: 'manager' })).toEqual([]);
  });
  it('rejects common passwords, digit-only passwords, runs and passwords containing the person\'s name', () => {
    expect(passwordProblems('Password123!', { role: 'admin' }).join(' ')).toMatch(/common/);
    expect(passwordProblems('12345678', { role: 'cashier' }).join(' ')).toMatch(/digits/);
    expect(passwordProblems('qwertyuiop12', { role: 'admin' }).length).toBeGreaterThan(0);
    expect(passwordProblems('Mwangi-2026-tele', { role: 'cashier', name: 'Peter Mwangi' }).join(' ')).toMatch(/name/);
  });
  it('is enforced when changing a password', async () => {
    const u = makeUser({ role: 'manager' });
    const { token } = await signIn(u.email);
    const weak = await request(app).post('/api/auth/change-password').set(auth(token)).send({ currentPassword: PW, newPassword: 'Password123!' });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');
    const ok = await request(app).post('/api/auth/change-password').set(auth(token)).send({ currentPassword: PW, newPassword: 'Violet-Harbour-2291' });
    expect(ok.status).toBe(200);
  });
});

describe('account lockout', () => {
  it('locks an account after repeated wrong passwords, even for the right password, and tells the admins', async () => {
    const u = makeUser();
    for (let i = 0; i < 5; i += 1) {
      const bad = await request(app).post('/api/auth/login').set('X-Forwarded-For', ip()).send({ email: u.email, password: 'wrong-wrong-wrong' });
      expect(bad.status).toBe(401);
    }
    const locked = await request(app).post('/api/auth/login').set('X-Forwarded-For', ip()).send({ email: u.email, password: PW });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');

    const ev = db.prepare(`SELECT * FROM security_events WHERE type = 'account_locked' AND subject_id = ?`).get(u.id);
    expect(ev).toBeTruthy();
    expect(ev.severity).toBe('urgent');
    const note = db.prepare(`SELECT 1 FROM notifications WHERE type = 'security' AND title LIKE ?`).get(`%Session Tester%`);
    expect(note).toBeTruthy();

    db.prepare('UPDATE users SET locked_until = ? WHERE id = ?').run(new Date(Date.now() - MIN).toISOString(), u.id);   // lock expires
    const again = await request(app).post('/api/auth/login').set('X-Forwarded-For', ip()).send({ email: u.email, password: PW });
    expect(again.status).toBe(200);
  });

  it('resets the counter after a good sign-in', async () => {
    const u = makeUser();
    for (let i = 0; i < 4; i += 1) await request(app).post('/api/auth/login').set('X-Forwarded-For', ip()).send({ email: u.email, password: 'nope-nope-nope' });
    expect((await request(app).post('/api/auth/login').set('X-Forwarded-For', ip()).send({ email: u.email, password: PW })).status).toBe(200);
    for (let i = 0; i < 4; i += 1) await request(app).post('/api/auth/login').set('X-Forwarded-For', ip()).send({ email: u.email, password: 'nope-nope-nope' });
    expect((await request(app).post('/api/auth/login').set('X-Forwarded-For', ip()).send({ email: u.email, password: PW })).status).toBe(200);
  });

  it('locks PIN sign-in separately from password sign-in', async () => {
    const u = makeUser({ pin: '4826' });
    for (let i = 0; i < 5; i += 1) await request(app).post('/api/auth/pin-login').set('X-Forwarded-For', ip()).send({ userId: u.id, pin: '1111' });
    const pinLocked = await request(app).post('/api/auth/pin-login').set('X-Forwarded-For', ip()).send({ userId: u.id, pin: '4826' });
    expect(pinLocked.status).toBe(429);
    expect((await request(app).post('/api/auth/login').set('X-Forwarded-For', ip()).send({ email: u.email, password: PW })).status).toBe(200);
  });
});

describe('sessions: idle lock, idle sign-out, maximum length', () => {
  it('returns the timing rules with the sign-in and puts the session id in the token', async () => {
    const u = makeUser();
    const { res } = await signIn(u.email);
    expect(res.body.session.lockAfterSeconds).toBe(5 * 60);
    expect(res.body.session.signOutAfterSeconds).toBe(30 * 60);
    expect(res.body.session.remember).toBe(false);
  });

  it('locks after the idle time, refuses everything but unlocking, and unlocks with the password', async () => {
    const u = makeUser();
    const { token, sid } = await signIn(u.email);
    expect((await request(app).get('/api/auth/me').set(auth(token))).status).toBe(200);

    age(sid, 'last_activity_at', 6 * MIN);
    const locked = await request(app).get('/api/products').set(auth(token));
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('SESSION_LOCKED');
    expect((await request(app).get('/api/auth/me').set(auth(token))).status).toBe(200);   // still allowed while locked

    const wrong = await request(app).post('/api/auth/unlock').set('X-Forwarded-For', ip()).set(auth(token)).send({ password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    const ok = await request(app).post('/api/auth/unlock').set('X-Forwarded-For', ip()).set(auth(token)).send({ password: PW });
    expect(ok.status).toBe(200);
    expect((await request(app).get('/api/products').set(auth(token))).status).toBe(200);
  });

  it('lets a cashier unlock with their PIN, but not an admin', async () => {
    const cashier = makeUser({ pin: '7351' });
    const a = await signIn(cashier.email);
    age(a.sid, 'last_activity_at', 6 * MIN);
    expect((await request(app).post('/api/auth/unlock').set(auth(a.token)).send({ pin: '7351' })).status).toBe(200);

    const mgr = makeUser({ role: 'manager', pin: '7351' });
    const b = await signIn(mgr.email);
    age(b.sid, 'last_activity_at', 11 * MIN);
    const refused = await request(app).post('/api/auth/unlock').set(auth(b.token)).send({ pin: '7351' });
    expect(refused.status).toBe(403);
  });

  it('ends the session after the idle sign-out time, for the token and for refreshing', async () => {
    const u = makeUser();
    const { token, cookie, sid } = await signIn(u.email);
    age(sid, 'last_activity_at', 31 * MIN);
    const r1 = await request(app).get('/api/products').set(auth(token));
    expect(r1.status).toBe(401);
    expect(r1.body.error.code).toBe('SESSION_EXPIRED');
    const r2 = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(r2.status).toBe(401);
    expect(r2.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('a remembered device only locks when idle; it is not signed out for being idle', async () => {
    const u = makeUser({ role: 'manager' });
    const { token, sid, res } = await signIn(u.email, { remember: true });
    expect(res.body.session.remember).toBe(true);
    expect(res.body.session.signOutAfterSeconds).toBeNull();
    age(sid, 'last_activity_at', 5 * 60 * MIN);
    const r = await request(app).get('/api/products').set(auth(token));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('SESSION_LOCKED');
  });

  it('enforces the maximum session length however active the user is', async () => {
    const u = makeUser();
    const { token, cookie, sid } = await signIn(u.email);
    db.prepare('UPDATE auth_sessions SET absolute_expires_at = ? WHERE id = ?').run(new Date(Date.now() - MIN).toISOString(), sid);
    expect((await request(app).get('/api/products').set(auth(token))).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', cookie)).status).toBe(401);
  });

  it('only real actions keep a session alive, not reading or background polling', async () => {
    const u = makeUser();
    const { token, sid } = await signIn(u.email);
    age(sid, 'last_activity_at', 3 * MIN);
    await request(app).get('/api/products').set(auth(token));
    let row = db.prepare('SELECT last_activity_at FROM auth_sessions WHERE id = ?').get(sid);
    expect(Date.now() - Date.parse(row.last_activity_at)).toBeGreaterThan(2.9 * MIN);

    await request(app).post('/api/auth/activity').set(auth(token)).set('X-Background', '1').send({});
    row = db.prepare('SELECT last_activity_at FROM auth_sessions WHERE id = ?').get(sid);
    expect(Date.now() - Date.parse(row.last_activity_at)).toBeGreaterThan(2.9 * MIN);

    await request(app).post('/api/auth/activity').set(auth(token)).send({});
    row = db.prepare('SELECT last_activity_at FROM auth_sessions WHERE id = ?').get(sid);
    expect(Date.now() - Date.parse(row.last_activity_at)).toBeLessThan(MIN);
  });

  it('a refresh keeps the session going but does not count as activity or extend its maximum', async () => {
    const u = makeUser();
    const { cookie, sid } = await signIn(u.email);
    const before = db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(sid);
    age(sid, 'last_activity_at', 3 * MIN);
    const r = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(r.status).toBe(200);
    const after = db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(sid);
    expect(after.absolute_expires_at).toBe(before.absolute_expires_at);
    expect(Date.now() - Date.parse(after.last_activity_at)).toBeGreaterThan(2.9 * MIN);
  });
});

describe('remember this device', () => {
  it('gives a browser-session cookie when unticked and a lasting cookie when ticked', async () => {
    const u = makeUser({ role: 'manager' });
    const plain = await signIn(u.email);
    const plainCookie = plain.res.headers['set-cookie'].find((c) => c.startsWith('ut_refresh_token='));
    expect(plainCookie).not.toMatch(/Max-Age|Expires/i);

    const kept = await signIn(u.email, { remember: true });
    const keptCookie = kept.res.headers['set-cookie'].find((c) => c.startsWith('ut_refresh_token='));
    expect(keptCookie).toMatch(/Max-Age=/i);
  });

  it('caps an unremembered session at 12 hours, and a remembered one at the role maximum', async () => {
    const mgr = makeUser({ role: 'manager' });
    const a = await signIn(mgr.email);
    const b = await signIn(mgr.email, { remember: true });
    const hours = (sid) => (Date.parse(db.prepare('SELECT absolute_expires_at FROM auth_sessions WHERE id = ?').get(sid).absolute_expires_at) - Date.now()) / 3600000;
    expect(hours(a.sid)).toBeGreaterThan(11.9); expect(hours(a.sid)).toBeLessThan(12.1);
    expect(hours(b.sid)).toBeGreaterThan(167); expect(hours(b.sid)).toBeLessThan(168.1);
  });
});

describe('signed-in devices and sign-out-everywhere', () => {
  it('lists my devices, marks the current one, and signs the others out', async () => {
    const u = makeUser();
    const first = await signIn(u.email);
    const second = await signIn(u.email);
    const list = await request(app).get('/api/auth/sessions').set(auth(second.token));
    expect(list.body.sessions.length).toBe(2);
    expect(list.body.sessions.filter((s) => s.current).length).toBe(1);

    const out = await request(app).post('/api/auth/sessions/revoke-others').set(auth(second.token)).send({});
    expect(out.body.ended).toBe(1);
    expect((await request(app).get('/api/products').set(auth(first.token))).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', first.cookie)).status).toBe(401);
    expect((await request(app).get('/api/products').set(auth(second.token))).status).toBe(200);
  });

  it('cannot end somebody else\'s session', async () => {
    const a = makeUser(); const b = makeUser();
    const sa = await signIn(a.email); const sb = await signIn(b.email);
    const res = await request(app).delete(`/api/auth/sessions/${sb.sid}`).set(auth(sa.token));
    expect(res.status).toBe(404);
  });

  it('a password change signs out every device', async () => {
    const u = makeUser();
    const one = await signIn(u.email); const two = await signIn(u.email);
    await request(app).post('/api/auth/change-password').set(auth(one.token)).send({ currentPassword: PW, newPassword: 'Granite-Orchard-5120' });
    expect((await request(app).get('/api/products').set(auth(two.token))).status).toBe(401);
  });
});

describe('stolen refresh token detection', () => {
  it('ends the whole session and alerts the admins when an already-used refresh token comes back', async () => {
    const u = makeUser();
    const { cookie: oldCookie, sid } = await signIn(u.email);
    const rotated = await request(app).post('/api/auth/refresh').set('Cookie', oldCookie);
    expect(rotated.status).toBe(200);
    const newToken = rotated.body.token;

    // inside the short grace window a second tab replaying it is just refused
    expect((await request(app).post('/api/auth/refresh').set('Cookie', oldCookie)).status).toBe(401);
    expect((await request(app).get('/api/products').set(auth(newToken))).status).toBe(200);

    // later, the same old token again means someone copied it
    db.prepare(`UPDATE refresh_tokens SET revoked_at = datetime('now', '-5 minutes') WHERE session_id = ? AND replaced_by_id IS NOT NULL`).run(sid);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', oldCookie)).status).toBe(401);
    expect((await request(app).get('/api/products').set(auth(newToken))).status).toBe(401);
    expect(db.prepare(`SELECT 1 FROM security_events WHERE type = 'session_reuse' AND subject_id = ?`).get(u.id)).toBeTruthy();
  });
});

describe('admin gets in as before', () => {
  it('seeded admin sign-in still works and carries a session', async () => {
    const res = await request(app).post('/api/auth/login').set('X-Forwarded-For', ip()).send({ email: 'admin@urbantrends.com', password: 'ChangeMe123!' });
    const token = res.body.token;
    expect(token).toBeTruthy();
    expect((await request(app).get('/api/auth/me').set(auth(token))).body.session.id).toBeTruthy();
  });
});
