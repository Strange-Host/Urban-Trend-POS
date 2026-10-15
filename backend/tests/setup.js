const fs = require('fs');
const path = require('path');
const os = require('os');

// A fresh, isolated SQLite file per test run — never touches the real
// backend/data/urban_trends.db. Env vars must be set before anything
// requires config/db.js (which reads them at module-load time via
// dotenv), so this file must be imported first, before the app.
const tmpDbPath = path.join(os.tmpdir(), `utpos-test-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDbPath;
process.env.JWT_SECRET = 'test-jwt-secret-do-not-use-in-prod';
process.env.ENCRYPTION_KEY = 'test-encryption-key-do-not-use-in-prod';
process.env.NODE_ENV = 'test';
process.env.CORS_ORIGIN = 'http://localhost:5173';

require('../src/db/migrate');
require('../src/db/seed');

// The optional modules (HR & back office, control extras) ship switched OFF. Most tests exercise those
// features, so they start with both ON; tests/modules.test.js switches them off to test the off state.
require('../src/config/db').prepare(
  `INSERT INTO settings (key, value) VALUES ('module_hr_enabled', '1'), ('module_control_enabled', '1')
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
).run();

const request = require('supertest');
const app = require('../src/app');

async function loginAsAdmin() {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@urbantrends.com', password: 'ChangeMe123!' });
  return res.body.token;
}

// The refresh token now arrives as a Set-Cookie header, not a response
// body field — pulls out just the "name=value" part so it can be replayed
// as a Cookie header on a subsequent request (supertest doesn't carry
// cookies between separate `request(app)` calls automatically).
function extractRefreshCookie(res) {
  const setCookieHeader = res.headers['set-cookie'];
  if (!setCookieHeader) return null;
  const cookieLine = setCookieHeader.find((c) => c.startsWith('ut_refresh_token='));
  return cookieLine ? cookieLine.split(';')[0] : null;
}

function cleanupTestDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = tmpDbPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

module.exports = { app, request, loginAsAdmin, extractRefreshCookie, cleanupTestDb, tmpDbPath };
