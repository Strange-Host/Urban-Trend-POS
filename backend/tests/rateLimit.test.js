const { app, request, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const Store = require('../src/utils/sqliteRateLimitStore');
const { RATE_LIMITS } = require('../src/config/limits');

afterAll(() => cleanupTestDb());
beforeEach(() => db.exec('DELETE FROM rate_limits'));

const WINDOW = 15 * 60 * 1000;
function store(opts = {}) {
  const s = new Store({ scope: 'test', ...opts });
  s.init({ windowMs: WINDOW });
  return s;
}

describe('SqliteRateLimitStore', () => {
  it('counts hits per address inside a window and reports when it resets', () => {
    let now = 1_000_000;
    const s = store({ now: () => now });
    expect(s.increment('1.2.3.4')).toEqual({ totalHits: 1, resetTime: new Date(1_000_000 + WINDOW) });
    now += 60_000;
    expect(s.increment('1.2.3.4').totalHits).toBe(2);
    expect(s.increment('1.2.3.4').resetTime).toEqual(new Date(1_000_000 + WINDOW)); // the window runs from the first hit
    expect(s.increment('5.6.7.8').totalHits).toBe(1);                                // another address is counted apart
  });

  it('starts a new window once the old one has ended', () => {
    let now = 1_000_000;
    const s = store({ now: () => now });
    for (let i = 0; i < 5; i++) s.increment('a');
    now += WINDOW - 1;
    expect(s.increment('a').totalHits).toBe(6);
    now += 1;
    expect(s.increment('a')).toEqual({ totalHits: 1, resetTime: new Date(now + WINDOW) });
  });

  it('keeps one limiter\'s counts apart from another\'s', () => {
    const a = store({ scope: 'login' }); const b = store({ scope: 'sync' });
    a.increment('x'); a.increment('x');
    expect(b.increment('x').totalHits).toBe(1);
    a.resetAll();
    expect(a.get('x')).toBeUndefined();
    expect(b.get('x').totalHits).toBe(1);
  });

  it('survives a restart and is shared by every process on the same database', () => {
    const before = store();
    for (let i = 0; i < 7; i++) before.increment('1.2.3.4');
    const afterRestart = store();               // a brand-new store object, as after a restart or in a second process
    expect(afterRestart.get('1.2.3.4').totalHits).toBe(7);
    expect(afterRestart.increment('1.2.3.4').totalHits).toBe(8);
    expect(before.increment('1.2.3.4').totalHits).toBe(9);
  });

  it('can be decremented and reset, and never goes below zero', () => {
    const s = store();
    s.increment('k'); s.decrement('k'); s.decrement('k');
    expect(s.get('k').totalHits).toBe(0);
    s.increment('k'); s.resetKey('k');
    expect(s.get('k')).toBeUndefined();
  });

  it('sweeps windows that ended more than a day ago, but only now and then', () => {
    let now = 10 * 86_400_000;
    const s = store({ now: () => now });
    s.increment('old');
    now += 2 * 86_400_000;
    s.increment('new');                         // the sweep rides on this write
    expect(db.prepare(`SELECT key FROM rate_limits`).all().map((r) => r.key)).toEqual(['test:new']);
  });

  it('needs a scope', () => {
    expect(() => new Store({})).toThrow(/scope/);
  });
});

describe('the sign-in limiter', () => {
  const attempt = () => request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password-123' });

  it('refuses an address after too many attempts, and the count outlives the process', async () => {
    for (let i = 0; i < RATE_LIMITS.LOGIN.max; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['ratelimit-remaining']).toBe('0');

    const row = db.prepare(`SELECT key, count FROM rate_limits WHERE key LIKE 'login:%'`).get();
    expect(row.count).toBe(RATE_LIMITS.LOGIN.max + 1);
    // "restart": a fresh store over the same database still knows this address is over the limit
    const fresh = new Store({ scope: 'login' });
    fresh.init({ windowMs: RATE_LIMITS.LOGIN.windowMs });
    expect(fresh.get(row.key.slice('login:'.length)).totalHits).toBe(RATE_LIMITS.LOGIN.max + 1);
  });

  it('the PIN, one-time-code and unlock endpoints share that one allowance', async () => {
    await request(app).post('/api/auth/pin-login').send({ pin: '123456' });      // the 1st hit shows which key this address is counted under
    const { key } = db.prepare(`SELECT key FROM rate_limits WHERE key LIKE 'login:%'`).get();
    db.prepare('UPDATE rate_limits SET count = ? WHERE key = ?').run(RATE_LIMITS.LOGIN.max - 1, key);
    expect((await request(app).post('/api/auth/pin-login').send({ pin: '123456' })).status).not.toBe(429); // the 20th is allowed
    expect((await request(app).post('/api/auth/verify-otp').send({ code: '000000' })).status).toBe(429);   // the 21st is not
    expect((await request(app).post('/api/auth/resend-otp').send({})).status).toBe(429);
  });

  it('does not turn sign-in into an error if the counter cannot be written', async () => {
    db.exec('ALTER TABLE rate_limits RENAME TO rate_limits_away');
    try {
      expect((await attempt()).status).toBe(401);  // let through; the per-account lockout still protects the account
    } finally {
      db.exec('ALTER TABLE rate_limits_away RENAME TO rate_limits');
    }
  });
});
