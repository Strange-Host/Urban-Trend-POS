const bcrypt = require('bcryptjs');
const { app, request, cleanupTestDb } = require('./setup');
// NOTE: must come AFTER ./setup — setup sets DATABASE_PATH to a temp file before config/db.js
// is first loaded. Requiring db first opened the real data/urban_trends.db and wrote test rows into it.
const db = require('../src/config/db');

let tempUserToken;

beforeAll(async () => {
  // Simulates what seed.js now does in production: a temporary password + must_change_password = 1.
  const stores = db.prepare('SELECT id FROM stores LIMIT 1').get();
  const passwordHash = bcrypt.hashSync('Velvet-Compass-8046', 10);
  db.prepare(`
    INSERT INTO users (store_id, name, email, password_hash, role, is_active, must_change_password)
    VALUES (?, 'Temp User', 'tempuser@urbantrends.com', ?, 'admin', 1, 1)
  `).run(stores.id, passwordHash);

  const loginRes = await request(app).post('/api/auth/login').send({ email: 'tempuser@urbantrends.com', password: 'Velvet-Compass-8046' });
  expect(loginRes.status).toBe(200);
  expect(loginRes.body.user.must_change_password).toBe(1);
  tempUserToken = loginRes.body.token;
});

afterAll(() => cleanupTestDb());

describe('forced password change (Phase 2.1)', () => {
  it('blocks an ordinary route while must_change_password is set', async () => {
    const res = await request(app).get('/api/products').set('Authorization', `Bearer ${tempUserToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('still allows /me and /logout while must_change_password is set', async () => {
    const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tempUserToken}`);
    expect(meRes.status).toBe(200);
    // Not calling /logout here — it would revoke the session this test file still needs below.
  });

  it('rejects change-password with the wrong current password', async () => {
    const res = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${tempUserToken}`)
      .send({ currentPassword: 'WrongPassword!', newPassword: 'Granite-Lotus-5513' });
    expect(res.status).toBe(401);
  });

  it('rejects a new password under 8 characters', async () => {
    const res = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${tempUserToken}`)
      .send({ currentPassword: 'Velvet-Compass-8046', newPassword: 'short' });
    expect(res.status).toBe(400);
  });

  it('changes the password, clears the gate, and invalidates the old session', async () => {
    const res = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${tempUserToken}`)
      .send({ currentPassword: 'Velvet-Compass-8046', newPassword: 'Granite-Lotus-5513' });
    expect(res.status).toBe(200);

    // The token used to change the password is now stale (token_version bumped).
    const staleRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tempUserToken}`);
    expect(staleRes.status).toBe(401);

    // Logging in again with the NEW password works, and the gate is gone.
    const reloginRes = await request(app).post('/api/auth/login').send({ email: 'tempuser@urbantrends.com', password: 'Granite-Lotus-5513' });
    expect(reloginRes.status).toBe(200);
    expect(reloginRes.body.user.must_change_password).toBe(0);

    // And ordinary routes now work with the new session.
    const productsRes = await request(app).get('/api/products').set('Authorization', `Bearer ${reloginRes.body.token}`);
    expect(productsRes.status).toBe(200);

    // The OLD password no longer works.
    const oldPasswordRes = await request(app).post('/api/auth/login').send({ email: 'tempuser@urbantrends.com', password: 'Velvet-Compass-8046' });
    expect(oldPasswordRes.status).toBe(401);
  });
});
