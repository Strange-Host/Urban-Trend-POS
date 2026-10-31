const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { userOrIpKey } = require('../src/utils/rateLimitKey');
const { RATE_LIMITS } = require('../src/config/limits');
const logger = require('../src/utils/logger');

afterAll(() => cleanupTestDb());

const tokenFor = (id, secret = process.env.JWT_SECRET, opts = { expiresIn: '15m' }) => jwt.sign({ id }, secret, opts);

describe('userOrIpKey', () => {
  const req = (headers = {}, extra = {}) => ({ headers, ip: '203.0.113.7', ...extra });

  it('counts a valid signed-in request against the user, not the shared IP', () => {
    expect(userOrIpKey(req({ authorization: `Bearer ${tokenFor(4)}` }))).toBe('user:4');
    expect(userOrIpKey(req({ authorization: `Bearer ${tokenFor(9)}` }))).toBe('user:9');
  });

  it('uses req.user when authenticate() has already run', () => {
    expect(userOrIpKey(req({}, { user: { id: 12 } }))).toBe('user:12');
  });

  it('falls back to the IP for no token, forged, wrong-secret, expired and malformed tokens', () => {
    expect(userOrIpKey(req())).toBe('ip:203.0.113.7');
    expect(userOrIpKey(req({ authorization: 'Bearer not-a-jwt' }))).toBe('ip:203.0.113.7');
    expect(userOrIpKey(req({ authorization: `Bearer ${tokenFor(4, 'some-other-secret')}` }))).toBe('ip:203.0.113.7');
    expect(userOrIpKey(req({ authorization: `Bearer ${tokenFor(4, process.env.JWT_SECRET, { expiresIn: -10 })}` }))).toBe('ip:203.0.113.7');
    expect(userOrIpKey(req({ authorization: 'Basic abc' }))).toBe('ip:203.0.113.7');
  });
});

describe('tills behind one public IP', () => {
  function miniApp(max) {
    const a = express();
    a.set('trust proxy', 1);
    a.use(rateLimit({ windowMs: 60_000, max, standardHeaders: true, keyGenerator: userOrIpKey }));
    a.get('/ping', (_req, res) => res.json({ ok: true }));
    return a;
  }
  const hit = (a, id) => {
    const r = request(a).get('/ping').set('X-Forwarded-For', '198.51.100.20');   // the same shop IP every time
    return id ? r.set('Authorization', `Bearer ${tokenFor(id)}`) : r;
  };

  it('gives each signed-in user their own allowance', async () => {
    const a = miniApp(3);
    for (let i = 0; i < 3; i++) expect((await hit(a, 1)).status).toBe(200);
    expect((await hit(a, 1)).status).toBe(429);          // till 1 used its own budget up ...
    expect((await hit(a, 2)).status).toBe(200);          // ... till 2, same IP, is untouched
  });

  it('still limits anonymous traffic per IP, and a forged token cannot escape that', async () => {
    const a = miniApp(3);
    for (let i = 0; i < 3; i++) expect((await hit(a)).status).toBe(200);
    expect((await hit(a)).status).toBe(429);
    const forged = await request(a).get('/ping').set('X-Forwarded-For', '198.51.100.20').set('Authorization', `Bearer ${tokenFor(77, 'wrong-secret')}`);
    expect(forged.status).toBe(429);
  });

  it('a user cannot dodge their limit by changing IP', async () => {
    const a = miniApp(2);
    const from = (ip) => request(a).get('/ping').set('X-Forwarded-For', ip).set('Authorization', `Bearer ${tokenFor(5)}`);
    expect((await from('192.0.2.1')).status).toBe(200);
    expect((await from('192.0.2.2')).status).toBe(200);
    expect((await from('192.0.2.3')).status).toBe(429);
  });

  it('the real API: exhausting the anonymous IP budget does not lock out a signed-in till', async () => {
    const token = await loginAsAdmin();
    for (let i = 0; i < RATE_LIMITS.GENERAL_API.max + 1; i++) await request(app).get('/api/health');
    expect((await request(app).get('/api/health')).status).toBe(429);
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
  }, 60_000);
});

describe('log rotation', () => {
  it('caps app.log and error.log by size and number of files', () => {
    const files = logger.transports.filter((t) => /File/i.test(t.constructor.name));
    expect(files.map((t) => t.filename).sort()).toEqual(['app.log', 'error.log']);
    for (const t of files) {
      expect(t.maxsize).toBe(10 * 1024 * 1024);
      expect(t.maxFiles).toBe(5);
      expect(t.tailable).toBe(true);
    }
  });
});
