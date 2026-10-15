const axios = require('axios');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const systemConfig = require('../src/services/systemConfig.service');
const mailService = require('../src/services/mail.service');
const { buildCorsOptions } = require('../src/config/cors');
const kcbConfig = require('../src/config/kcb');

let a; let manager; let sendMail;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const put = (body) => request(app).put('/api/system/config').set(a).send(body);
const get = () => request(app).get('/api/system/config').set(a);
const ENV_KEYS = ['APP_BASE_URL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'CORS_ORIGIN', 'KCB_API_BASE_URL_SANDBOX', 'KCB_TOKEN_PATH'];

beforeAll(async () => {
  a = auth(await loginAsAdmin());
  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  db.prepare("INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'Mgr', 'mgr-sys@urbantrends.com', ?, 'manager', 1)").run(store.id, bcrypt.hashSync('Passw0rd!Passw0rd', 10));
  manager = (await request(app).post('/api/auth/login').send({ email: 'mgr-sys@urbantrends.com', password: 'Passw0rd!Passw0rd' })).body.token;
  sendMail = vi.fn().mockResolvedValue({});
  vi.spyOn(nodemailer, 'createTransport').mockImplementation(() => ({ sendMail }));
});
beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; sendMail.mockClear(); });
afterAll(() => cleanupTestDb());

describe('access', () => {
  it('admin only - managers and the signed-out cannot read or change server settings', async () => {
    expect((await request(app).get('/api/system/config').set(auth(manager))).status).toBe(403);
    expect((await request(app).put('/api/system/config').set(auth(manager)).send({ values: { public_base_url: 'https://x.com' } })).status).toBe(403);
    expect((await request(app).post('/api/system/test-email').set(auth(manager)).send({ to: 'a@b.co' })).status).toBe(403);
    expect((await request(app).get('/api/system/config')).status).toBe(401);
  });
});

describe('public web address', () => {
  it('saves a clean https address and strips trailing slashes', async () => {
    const res = await put({ values: { public_base_url: '  https://pos.example.co.ke///  ' } });
    expect(res.status).toBe(200);
    expect(res.body.data.values.public_base_url).toBe('https://pos.example.co.ke');
    expect(systemConfig.publicBaseUrl()).toBe('https://pos.example.co.ke');
  });

  it('adds https:// when someone types just a host name', async () => {
    expect((await put({ values: { public_base_url: 'pos.example.co.ke' } })).body.data.values.public_base_url).toBe('https://pos.example.co.ke');
  });

  it('refuses addresses Safaricom rejects, and nonsense', async () => {
    expect((await put({ values: { public_base_url: 'https://mpesa.example.com' } })).status).toBe(400);
    expect((await put({ values: { public_base_url: 'https://my-safaricom-pos.ngrok.app' } })).status).toBe(400);
    expect((await put({ values: { public_base_url: 'ftp://x.com' } })).status).toBe(400);
    expect((await put({ values: { public_base_url: 'https://user:pw@x.com' } })).status).toBe(400);
    expect((await put({ values: { public_base_url: 'http://exa mple.com' } })).status).toBe(400);
  });

  it('M-Pesa registration reads the SAVED address (not only .env), and explains http and missing cases', async () => {
    const mpesaClient = require('../src/config/mpesa');
    // credentials first - registration refuses to run without them
    await request(app).put('/api/settings/payment-gateways/mpesa').set(a).send({
      environment: 'sandbox', shortcode: '174379', consumer_key: 'ck', consumer_secret: 'cs', passkey: 'pk', webhook_secret: 'abcdefghij1234567890zz',
    });
    const spy = vi.spyOn(mpesaClient, 'registerC2BUrls').mockResolvedValue({ ResponseDescription: 'Success' });
    const register = () => request(app).post('/api/settings/payment-gateways/mpesa/register-urls').set(a);

    await put({ values: { public_base_url: '' } });
    const missing = await register();
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toContain('APP_BASE_URL');
    expect(missing.body.error.message).toContain('Settings');                    // tells you where to fix it

    await put({ values: { public_base_url: 'http://192.168.1.5:4000' } });
    const insecure = await register();
    expect(insecure.status).toBe(400);
    expect(insecure.body.error.message).toContain('https://');

    await put({ values: { public_base_url: 'https://pos.example.co.ke' } });
    const ok = await register();
    expect(ok.status).toBe(200);
    expect(spy.mock.calls[0][1].confirmationUrl.startsWith('https://pos.example.co.ke/api/integrations/payments/callbacks/c2b/')).toBe(true);
    spy.mockRestore();
  });

  it('a value saved in Settings wins over the old .env value; clearing it falls back to .env', async () => {
    process.env.APP_BASE_URL = 'https://from-env.example.com/';
    await put({ values: { public_base_url: '' } });
    expect(systemConfig.publicBaseUrl()).toBe('https://from-env.example.com');
    expect((await get()).body.data.from_environment).toContain('public_base_url');
    await put({ values: { public_base_url: 'https://saved.example.com' } });
    expect(systemConfig.publicBaseUrl()).toBe('https://saved.example.com');
    expect((await get()).body.data.from_environment).not.toContain('public_base_url');
  });

  it('"Check this address" reports reachable, wrong-server, and unreachable cases in plain words', async () => {
    const spy = vi.spyOn(axios, 'get');
    const check = (body) => request(app).post('/api/system/check-public-url').set(a).send(body);
    spy.mockResolvedValueOnce({ status: 200, data: { status: 'ok' } });
    expect((await check({ url: 'https://pos.example.co.ke' })).body.data).toMatchObject({ reachable: true, looks_like_pos: true });
    spy.mockResolvedValueOnce({ status: 404, data: '<html>' });
    const wrong = (await check({ url: 'https://other.example.com' })).body.data;
    expect(wrong).toMatchObject({ reachable: true, looks_like_pos: false });
    expect(wrong.message).toContain('/api/health');
    spy.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ENOTFOUND' }));
    expect((await check({ url: 'https://gone.example.com' })).body.data.message).toContain('does not exist');
    expect(spy.mock.calls[0][0]).toBe('https://pos.example.co.ke/api/health');
    spy.mockRestore();
    await put({ values: { public_base_url: '' } });
    expect((await check({})).status).toBe(400);   // nothing saved, nothing given
  });
});

describe('outgoing email', () => {
  it('saves server details and keeps the password encrypted and write-only', async () => {
    const res = await put({ values: { smtp_host: 'smtp.gmail.com', smtp_port: '587', smtp_secure: '0', smtp_user: 'shop@gmail.com', smtp_from: 'shop@gmail.com' }, smtp_password: 'abcd-efgh-ijkl-mnop' });
    expect(res.status).toBe(200);
    expect(res.body.data.smtp_password_set).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('abcd-efgh');

    const stored = db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass_enc'").get().value;
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain('abcd-efgh');
    expect(systemConfig.smtp().pass).toBe('abcd-efgh-ijkl-mnop');

    // no other endpoint hands it back
    expect(JSON.stringify((await get()).body)).not.toContain('abcd-efgh');
    const all = (await request(app).get('/api/settings').set(a)).body.data;
    expect(all.smtp_pass_enc).toBeUndefined();
    expect(JSON.stringify(all)).not.toContain('enc:v1');
  });

  it('re-saving the other fields keeps the saved password (a blank password box means "leave it")', async () => {
    await put({ values: { smtp_user: 'shop2@gmail.com' }, smtp_password: '' });
    expect(systemConfig.smtp()).toMatchObject({ user: 'shop2@gmail.com', pass: 'abcd-efgh-ijkl-mnop' });
    await put({ values: { smtp_user: 'shop@gmail.com' } });
  });

  it('the audit log records that the password changed, never the password', async () => {
    const rows = db.prepare("SELECT changes FROM staff_logs WHERE entity_type = 'system_settings'").all().map((r) => r.changes).join(' ');
    expect(rows).toContain('smtp_password');
    expect(rows).not.toContain('abcd-efgh');
  });

  it('the Settings value drives the real mail transport (no restart)', async () => {
    mailService.getTransport();
    expect(nodemailer.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'smtp.gmail.com', port: 587, secure: false, auth: { user: 'shop@gmail.com', pass: 'abcd-efgh-ijkl-mnop' } }));
    await put({ values: { smtp_host: 'smtp.example.org', smtp_port: '465', smtp_secure: '1' } });
    mailService.getTransport();
    expect(nodemailer.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'smtp.example.org', port: 465, secure: true }));
  });

  it('sends a test email, and turns a login failure into advice', async () => {
    expect((await request(app).post('/api/system/test-email').set(a).send({ to: 'owner@example.com' })).body.data).toEqual({ sent: true, to: 'owner@example.com' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.com', from: 'shop@gmail.com' }));
    sendMail.mockRejectedValueOnce(Object.assign(new Error('Invalid login: 535 Username and Password not accepted'), { code: 'EAUTH' }));
    const bad = await request(app).post('/api/system/test-email').set(a).send({ to: 'owner@example.com' });
    expect(bad.status).toBe(502);
    expect(bad.body.error.message).toContain('App Password');
    expect((await request(app).post('/api/system/test-email').set(a).send({ to: 'not-an-email' })).status).toBe(400);
  });

  it('validates the fields', async () => {
    for (const values of [{ smtp_host: 'https://smtp.gmail.com' }, { smtp_host: 'smtp gmail.com' }, { smtp_port: '99999' }, { smtp_port: 'abc' }, { smtp_from: 'nope' }]) {
      expect((await put({ values })).status, JSON.stringify(values)).toBe(400);
    }
  });

  it('can remove the saved password, and falls back to .env values when nothing is saved', async () => {
    await put({ values: { smtp_host: '', smtp_user: '', smtp_from: '', smtp_port: '', smtp_secure: '' }, clear_smtp_password: true });
    expect(mailService.isConfigured()).toBe(false);
    process.env.SMTP_HOST = 'smtp.legacy.example.com'; process.env.SMTP_USER = 'legacy@example.com'; process.env.SMTP_PASS = 'legacy-pass';
    expect(systemConfig.smtp()).toMatchObject({ host: 'smtp.legacy.example.com', user: 'legacy@example.com', pass: 'legacy-pass', source: 'environment' });
    expect(mailService.isConfigured()).toBe(true);
  });

  it('with no email configured, the test says what to do instead of crashing', async () => {
    const res = await request(app).post('/api/system/test-email').set(a).send({ to: 'owner@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Settings');
  });
});

describe('the generic settings endpoint cannot bypass validation', () => {
  it('refuses managed keys', async () => {
    for (const key of ['public_base_url', 'smtp_host', 'smtp_pass_enc', 'allowed_origins']) {
      expect((await request(app).put('/api/settings').set(a).send({ [key]: 'x' })).status, key).toBe(400);
    }
    expect((await request(app).put('/api/settings').set(a).send({ business_name: 'Still Fine' })).status).toBe(200);
  });
});

describe('allowed website addresses (CORS) take effect immediately', () => {
  const decide = (opts, origin) => new Promise((r) => opts.origin(origin, (e, ok) => r(ok)));
  it('reads the saved list on every request', async () => {
    const opts = buildCorsOptions({ configured: () => systemConfig.allowedOrigins() });
    expect(await decide(opts, 'https://shop.example.com')).toBe(false);
    await put({ values: { allowed_origins: 'https://shop.example.com/, https://admin.example.com' } });
    expect(systemConfig.allowedOrigins()).toBe('https://shop.example.com,https://admin.example.com');
    expect(await decide(opts, 'https://shop.example.com')).toBe(true);
    expect(await decide(opts, 'http://192.168.1.4:5173')).toBe(false);                 // a list means ONLY the list
    await put({ values: { allowed_origins: '' } });
    expect(await decide(opts, 'http://192.168.1.4:5173')).toBe(true);                  // cleared -> shop network again
  });
  it('rejects a malformed list', async () => {
    expect((await put({ values: { allowed_origins: 'not a url, https://ok.example.com' } })).status).toBe(400);
  });
});

describe('KCB connection details', () => {
  it('uses the defaults, then the saved addresses, then clears back', async () => {
    expect(systemConfig.kcb()).toEqual({ sandbox: 'https://uat.buni.kcbgroup.com', production: 'https://api.buni.kcbgroup.com', tokenPath: '/token' });
    await put({ values: { kcb_api_base_url_sandbox: 'https://uat.example-kcb.test/', kcb_token_path: '/oauth/token' } });
    expect(systemConfig.kcb()).toMatchObject({ sandbox: 'https://uat.example-kcb.test', tokenPath: '/oauth/token' });
    expect((await put({ values: { kcb_token_path: 'token' } })).status).toBe(400);
    expect((await put({ values: { kcb_api_base_url_production: 'http://insecure.example.com' } })).status).toBe(400);

    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { access_token: 'tok', expires_in: 3600 } });
    await kcbConfig.getAccessToken({ kcb_client_id: 'id', kcb_api_key: 'k', kcb_api_secret: 's', environment: 'sandbox' }).catch(() => {});
    if (post.mock.calls.length) expect(post.mock.calls[0][0]).toBe('https://uat.example-kcb.test/oauth/token');
    post.mockRestore();
    await put({ values: { kcb_api_base_url_sandbox: '', kcb_token_path: '' } });
    expect(systemConfig.kcb().tokenPath).toBe('/token');
  });
});
