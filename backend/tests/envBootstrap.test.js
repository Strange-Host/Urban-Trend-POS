const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const { bootstrapEnv, isMissing, resolveDatabasePath, AUTO_SECRETS } = require('../src/config/env');
const { buildCorsOptions, isPrivateNetworkOrigin } = require('../src/config/cors');

const quiet = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
let dir;
let envPath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ut-env-'));
  envPath = path.join(dir, '.env');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
afterAll(() => cleanupTestDb());

const parse = (file) => Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));

describe('env bootstrap — first run', () => {
  it('creates .env with a unique, strong value for every auto secret, owner-only', () => {
    const env = {};
    const log = quiet();
    const out = bootstrapEnv({ envPath, env, log });

    expect(out).toEqual({ generated: AUTO_SECRETS, created: true });
    const written = parse(envPath);
    for (const key of AUTO_SECRETS) {
      expect(written[key]).toHaveLength(64);
      expect(env[key]).toBe(written[key]); // the running process gets the same values the file has
    }
    expect(new Set(AUTO_SECRETS.map((k) => written[k])).size).toBe(AUTO_SECRETS.length); // all different
    if (process.platform !== 'win32') expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.log.mock.calls[0][0]).toContain('nothing else to configure');
    expect(log.warn).not.toHaveBeenCalled();
    expect(fs.readFileSync(envPath, 'utf8')).toContain('KEEP IT PRIVATE');
  });

  it('two installs never share secrets', () => {
    const a = {}; const b = {};
    bootstrapEnv({ envPath, env: a, log: quiet() });
    bootstrapEnv({ envPath: path.join(dir, 'other.env'), env: b, log: quiet() });
    expect(a.JWT_SECRET).not.toBe(b.JWT_SECRET);
    expect(a.ENCRYPTION_KEY).not.toBe(b.ENCRYPTION_KEY);
  });

  it('a second start changes nothing and prints nothing', () => {
    bootstrapEnv({ envPath, env: {}, log: quiet() });
    const before = fs.readFileSync(envPath, 'utf8');
    const log = quiet();
    const env = {};
    const out = bootstrapEnv({ envPath, env, log });
    expect(out).toEqual({ generated: [], created: false });
    expect(fs.readFileSync(envPath, 'utf8')).toBe(before);
    expect(log.log).not.toHaveBeenCalled();
    expect(env.JWT_SECRET).toBe(parse(envPath).JWT_SECRET); // loaded from the file
  });
});

describe('env bootstrap — an existing .env', () => {
  it('replaces the placeholders from .env.example in place and leaves everything else alone', () => {
    fs.writeFileSync(envPath, [
      '# my notes', 'PORT=4100', 'JWT_SECRET=change_this_to_a_long_random_string', 'ENCRYPTION_KEY=change_this_to_a_different_long_random_string',
      'SMTP_HOST=smtp.example.com', 'CORS_ORIGIN=https://pos.example.com', '',
    ].join('\n'));
    const env = {};
    const out = bootstrapEnv({ envPath, env, log: quiet() });

    expect(out.generated.sort()).toEqual([...AUTO_SECRETS].sort());
    const text = fs.readFileSync(envPath, 'utf8');
    expect(text).toContain('# my notes');
    expect(text).toContain('PORT=4100');
    expect(text).toContain('SMTP_HOST=smtp.example.com');
    expect(text).toContain('CORS_ORIGIN=https://pos.example.com');
    expect(text).not.toContain('change_this');
    expect(text.match(/^JWT_SECRET=/gm)).toHaveLength(1); // replaced, not duplicated
    expect(env.PORT).toBe('4100');
  });

  it('never overwrites a real secret, and only fills what is missing', () => {
    fs.writeFileSync(envPath, 'JWT_SECRET=my-own-real-jwt-secret\nENCRYPTION_KEY=my-own-real-encryption-key\n');
    const env = {};
    const out = bootstrapEnv({ envPath, env, log: quiet() });
    expect(out.generated.sort()).toEqual(['LEAD_INTAKE_SECRET', 'PAYMENT_WEBHOOK_SECRET']);
    const written = parse(envPath);
    expect(written.JWT_SECRET).toBe('my-own-real-jwt-secret');
    expect(written.ENCRYPTION_KEY).toBe('my-own-real-encryption-key');
    expect(env.JWT_SECRET).toBe('my-own-real-jwt-secret');
  });

  it('a value supplied by the real environment (pm2, systemd, Docker) wins and is not written to the file', () => {
    const env = { JWT_SECRET: 'from-the-real-environment', ENCRYPTION_KEY: 'also-from-the-environment', PAYMENT_WEBHOOK_SECRET: 'x'.repeat(20), LEAD_INTAKE_SECRET: 'y'.repeat(20) };
    const out = bootstrapEnv({ envPath, env, log: quiet() });
    expect(out).toEqual({ generated: [], created: false });
    expect(fs.existsSync(envPath)).toBe(false); // nothing to write, so no file appears
    expect(env.JWT_SECRET).toBe('from-the-real-environment');
  });

  it('keeps Windows line endings and handles a file with no trailing newline', () => {
    fs.writeFileSync(envPath, 'PORT=4000\r\nJWT_SECRET=\r\nSMTP_PORT=587');
    bootstrapEnv({ envPath, env: {}, log: quiet() });
    const text = fs.readFileSync(envPath, 'utf8');
    expect(text).not.toMatch(/[^\r]\n/); // every newline is still \r\n
    expect(text).toContain('SMTP_PORT=587');
    expect(parse(envPath).JWT_SECRET.replace(/\r$/, '')).toHaveLength(64);
    expect(parse(envPath).ENCRYPTION_KEY.replace(/\r$/, '')).toHaveLength(64);
  });

  it('ignores commented-out secrets and an indented/export-prefixed line is still recognised', () => {
    fs.writeFileSync(envPath, '# JWT_SECRET=old-commented-value\nexport ENCRYPTION_KEY=\n');
    bootstrapEnv({ envPath, env: {}, log: quiet() });
    const text = fs.readFileSync(envPath, 'utf8');
    expect(text).toContain('# JWT_SECRET=old-commented-value');
    expect(text).toMatch(/^JWT_SECRET=.{64}$/m);
    expect(text).toMatch(/^export ENCRYPTION_KEY=.{64}$/m);
  });
});

describe('env bootstrap — safety', () => {
  it('refuses to start (instead of running on unsaved secrets) when the file cannot be written', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit called'); });
    const log = quiet();
    expect(() => bootstrapEnv({ envPath: path.join(dir, 'no', 'such', 'dir', '.env'), env: {}, log })).toThrow('exit called');
    expect(log.error.mock.calls[0][0]).toContain('Could not save the generated secrets');
    exit.mockRestore();
  });

  it('warns when a NEW encryption key appears next to an existing database', () => {
    const db = path.join(dir, 'urban_trends.db');
    fs.writeFileSync(db, 'x');
    const log = quiet();
    bootstrapEnv({ envPath, env: { DATABASE_PATH: db }, log });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain('re-entered in Settings');
  });

  it('does not warn on a brand-new install', () => {
    const log = quiet();
    bootstrapEnv({ envPath, env: { DATABASE_PATH: path.join(dir, 'fresh.db') }, log });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('treats blanks and the .env.example placeholders as missing, real values as present', () => {
    expect(isMissing(undefined)).toBe(true);
    expect(isMissing('')).toBe(true);
    expect(isMissing('   ')).toBe(true);
    expect(isMissing('change_this_to_a_long_random_string')).toBe(true);
    expect(isMissing('a-real-value')).toBe(false);
  });

  it('pins the database to backend/data regardless of the working directory, and resolves relative paths against backend/', () => {
    expect(resolveDatabasePath({})).toMatch(/backend[\\/]data[\\/]urban_trends\.db$/);
    expect(path.isAbsolute(resolveDatabasePath({ DATABASE_PATH: './data/x.db' }))).toBe(true);
    expect(resolveDatabasePath({ DATABASE_PATH: '/var/lib/ut/pos.db' })).toBe('/var/lib/ut/pos.db');
  });
});

describe('CORS — works with no configuration', () => {
  it('allows this machine and the shop network, on any port', () => {
    for (const o of [
      'http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173', 'https://localhost',
      'http://192.168.1.42:5173', 'http://10.0.0.7:3000', 'http://172.16.5.5:5173', 'http://172.31.255.1', 'http://pos-counter.local:5173',
    ]) expect(isPrivateNetworkOrigin(o), o).toBe(true);
  });

  it('blocks public websites, look-alike hosts and non-http origins', () => {
    for (const o of [
      'https://evil.example.com', 'http://192.168.1.42.evil.com', 'http://localhost.evil.com', 'http://172.32.0.1', 'http://172.15.0.1',
      'http://11.0.0.1', 'http://8.8.8.8', 'http://999.1.1.1', 'file:///etc/passwd', 'null', 'ftp://192.168.1.1', '',
    ]) expect(isPrivateNetworkOrigin(o), o).toBe(false);
  });

  const decide = (options, origin) => new Promise((resolve) => options.origin(origin, (err, allowed) => resolve({ err, allowed })));

  it('no Origin header (curl, a payment provider calling a webhook) is allowed', async () => {
    expect((await decide(buildCorsOptions({ configured: undefined }), undefined)).allowed).toBe(true);
  });

  it('a blocked origin is refused WITHOUT an error, and reported once', async () => {
    const onBlocked = vi.fn();
    const options = buildCorsOptions({ configured: undefined, onBlocked });
    const first = await decide(options, 'https://evil.example.com');
    expect(first).toEqual({ err: null, allowed: false });
    await decide(options, 'https://evil.example.com');
    await decide(options, 'https://another.example.org');
    expect(onBlocked.mock.calls.map((c) => c[0])).toEqual(['https://evil.example.com', 'https://another.example.org']);
  });

  it('CORS_ORIGIN, when set, is an exact allow-list (and LAN origins are then NOT implicitly allowed)', async () => {
    const options = buildCorsOptions({ configured: 'https://pos.example.com, https://admin.example.com' });
    expect((await decide(options, 'https://pos.example.com')).allowed).toBe(true);
    expect((await decide(options, 'https://admin.example.com')).allowed).toBe(true);
    expect((await decide(options, 'http://192.168.1.42:5173')).allowed).toBe(false);
    expect((await decide(options, 'https://pos.example.com.evil.com')).allowed).toBe(false);
  });

  it('an empty CORS_ORIGIN behaves as unset', async () => {
    expect((await decide(buildCorsOptions({ configured: '  ' }), 'http://localhost:5173')).allowed).toBe(true);
  });
});

describe('lead intake secret reveal', () => {
  it('admin only, and never cached', async () => {
    process.env.LEAD_INTAKE_SECRET = 'reveal-test-secret';
    const token = await loginAsAdmin();
    const ok = await request(app).get('/api/integrations/leads/secret').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ header: 'X-Intake-Secret', secret: 'reveal-test-secret', path: '/api/integrations/leads/intake' });
    expect(ok.headers['cache-control']).toBe('no-store');
    expect((await request(app).get('/api/integrations/leads/secret')).status).toBe(401);
  });
});
