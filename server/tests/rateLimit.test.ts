import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createUser } from '../src/auth/service.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';
import { makeTestDb, type TestDb } from './helpers.js';

let db: TestDb;
const appWith = (max: number, hops = 1) => createApp({ pool: db.pool, logger: createLogger('silent'), trustProxyHops: hops, signInLimit: { max, windowMinutes: 15 } });
beforeAll(async () => { db = await makeTestDb(); await runMigrations(db.pool); });
afterAll(() => db.drop());

let n = 0;
async function cashier(pin?: string) {
  const username = `cash${++n}l${Math.random().toString(36).slice(2, 6)}`;
  const { user, temporaryPassword } = await createUser(db.pool, { username, displayName: 'C', role: 'cashier', email: `${username}@shop.test`, pin, actor: 'test-setup' });
  return { id: user.id, username, email: `${username}@shop.test`, password: temporaryPassword };
}
const from = (ip: string) => ({ 'X-Forwarded-For': ip });

describe('limiting sign-in attempts per address', () => {
  it('lets an address try so many times, then answers 429 with when to come back, even for the right password', async () => {
    const app = appWith(3);
    const c = await cashier();
    for (let i = 0; i < 3; i++) expect((await request(app).post('/api/auth/login').set(from('10.1.0.1')).send({ email: c.email, password: 'wrong-wrong-1' })).status).toBe(401);
    const blocked = await request(app).post('/api/auth/login').set(from('10.1.0.1')).send({ email: c.email, password: c.password });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.body.error.message).toMatch(/Try again in \d+ minutes?/);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['ratelimit-limit']).toBe('3');
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
    expect(blocked.body.token).toBeUndefined();
  });

  it('counts per address: another address is not affected, and an address trying many different people is stopped', async () => {
    const app = appWith(3);
    for (let i = 0; i < 3; i++) await request(app).post('/api/auth/login').set(from('10.2.0.1')).send({ email: `nobody${i}@shop.test`, password: 'wrong-wrong-1' });
    expect((await request(app).post('/api/auth/login').set(from('10.2.0.1')).send({ email: 'someone.else@shop.test', password: 'wrong-wrong-1' })).status).toBe(429);
    const c = await cashier();
    expect((await request(app).post('/api/auth/login').set(from('10.2.0.2')).send({ email: c.email, password: c.password })).status).toBe(200);
  });

  it('shares one allowance between password sign-in, PIN sign-in and unlocking', async () => {
    const app = appWith(3);
    const c = await cashier('4829');
    const ip = from('10.3.0.1');
    const first = await request(app).post('/api/auth/login').set(ip).send({ email: c.email, password: c.password });
    await request(app).post('/api/auth/pin-login').set(ip).send({ userId: c.id, pin: '9999' });
    await request(app).post('/api/auth/unlock').set(ip).set('Authorization', `Bearer ${first.body.token}`).send({ password: 'wrong-wrong-1' }).expect((r) => { if (![401, 403].includes(r.status)) throw new Error(String(r.status)); });
    for (const [path, body] of [['/api/auth/login', { email: c.email, password: c.password }], ['/api/auth/pin-login', { userId: c.id, pin: '4829' }]] as const) {
      expect((await request(app).post(path).set(ip).send(body)).status, path).toBe(429);
    }
  });

  it('counts in the database, so another server instance shares it and a restart does not reset it', async () => {
    const c = await cashier();
    for (let i = 0; i < 3; i++) await request(appWith(3)).post('/api/auth/login').set(from('10.4.0.1')).send({ email: c.email, password: 'wrong-wrong-1' }); // a fresh app each time
    expect((await request(appWith(3)).post('/api/auth/login').set(from('10.4.0.1')).send({ email: c.email, password: c.password })).status).toBe(429);
  });

  it('starts a fresh allowance when the window ends', async () => {
    const app = appWith(2);
    const c = await cashier();
    for (let i = 0; i < 2; i++) await request(app).post('/api/auth/login').set(from('10.5.0.1')).send({ email: c.email, password: 'wrong-wrong-1' });
    expect((await request(app).post('/api/auth/login').set(from('10.5.0.1')).send({ email: c.email, password: c.password })).status).toBe(429);
    await db.pool.query(`UPDATE rate_limits SET window_start = window_start - interval '16 minutes' WHERE key = 'signin:10.5.0.1'`);
    expect((await request(app).post('/api/auth/login').set(from('10.5.0.1')).send({ email: c.email, password: c.password })).status).toBe(200);
  });

  it('does not touch the other routes, and can be switched off for tests', async () => {
    const app = appWith(1);
    const c = await cashier();
    await request(app).post('/api/auth/login').set(from('10.6.0.1')).send({ email: c.email, password: c.password });
    expect((await request(app).get('/api/health').set(from('10.6.0.1'))).status).toBe(200);
    expect((await request(app).post('/api/auth/logout').set(from('10.6.0.1'))).status).toBe(200); // signing out is never refused
    const off = createApp({ pool: db.pool, logger: createLogger('silent'), trustProxyHops: 1, signInLimit: false });
    for (let i = 0; i < 5; i++) expect((await request(off).post('/api/auth/login').set(from('10.6.0.2')).send({ email: c.email, password: 'wrong-wrong-1' })).status).toBe(401);
  });

  it('is on by default at 20 per 15 minutes when nothing is configured', async () => {
    const saved = process.env.LOGIN_RATE_LIMIT_MAX;
    delete process.env.LOGIN_RATE_LIMIT_MAX;
    try {
      const app = createApp({ pool: db.pool, logger: createLogger('silent'), trustProxyHops: 1 });
      const res = await request(app).post('/api/auth/login').set(from('10.7.0.1')).send({ email: 'x@shop.test', password: 'wrong-wrong-1' });
      expect(res.headers['ratelimit-limit']).toBe('20');
    } finally { if (saved !== undefined) process.env.LOGIN_RATE_LIMIT_MAX = saved; }
  });
});
