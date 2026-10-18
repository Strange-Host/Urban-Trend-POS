const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nodemailer = require('nodemailer');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const systemConfig = require('../src/services/systemConfig.service');
const mailService = require('../src/services/mail.service');

// Outgoing email is SMTP only (Resend support was removed). nodemailer is mocked: nothing leaves the machine.

let a; let smtpSendMail;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const put = (body) => request(app).put('/api/system/config').set(a).send(body);
const getConfig = () => request(app).get('/api/system/config').set(a);
const testEmail = (to = 'owner@example.com') => request(app).post('/api/system/test-email').set(a).send({ to });
const ENV_KEYS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_PORT', 'SMTP_SECURE'];
const SMTP = { smtp_host: 'smtp.example.org', smtp_port: '465', smtp_secure: '1', smtp_user: 'shop@example.org', smtp_from: 'Shop <shop@example.org>' };
const clearSmtp = () => put({ values: { smtp_host: '', smtp_port: '', smtp_secure: '', smtp_user: '', smtp_from: '' }, clear_smtp_password: true });

beforeAll(async () => {
  a = auth(await loginAsAdmin());
  smtpSendMail = vi.fn().mockResolvedValue({});
  vi.spyOn(nodemailer, 'createTransport').mockImplementation(() => ({ sendMail: smtpSendMail }));
});
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  smtpSendMail.mockReset().mockResolvedValue({});
});
afterAll(async () => { await clearSmtp(); cleanupTestDb(); });

describe('SMTP settings', () => {
  it('stores the password encrypted and never sends it back to the browser', async () => {
    const res = await put({ values: SMTP, smtp_password: 'pw-12345-secret' });
    expect(res.status).toBe(200);
    expect(res.body.data.smtp_password_set).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('pw-12345-secret');

    const stored = db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass_enc'").get().value;
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain('pw-12345-secret');
    expect(systemConfig.smtp()).toMatchObject({ host: 'smtp.example.org', port: 465, secure: true, user: 'shop@example.org', pass: 'pw-12345-secret' });

    expect(JSON.stringify((await getConfig()).body)).not.toContain('pw-12345-secret');
    const all = (await request(app).get('/api/settings').set(a)).body.data;
    expect(all.smtp_pass_enc).toBeUndefined();                     // the generic settings endpoint hides it too
  });

  it('has no trace of Resend any more: no method switch, no key', async () => {
    const cfg = (await getConfig()).body.data;
    expect(cfg.effective.mail_provider).toBeUndefined();
    expect(cfg.effective.resend_from).toBeUndefined();
    expect(cfg.resend_api_key_set).toBeUndefined();
    expect(cfg.values.mail_provider).toBeUndefined();
    expect(mailService.provider).toBeUndefined();
    // a stale client still sending the old fields cannot save a key anywhere
    const res = await put({ values: { mail_provider: 'resend' }, resend_api_key: 're_should_be_ignored' });
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) c FROM settings WHERE key IN ('mail_provider', 'resend_api_key_enc')").get().c).toBe(0);
  });

  it('leaves the saved password alone when blank, can remove it, and the audit trail never holds it', async () => {
    await put({ values: {}, smtp_password: '' });
    expect(systemConfig.smtp().pass).toBe('pw-12345-secret');
    const rows = JSON.stringify(db.prepare("SELECT changes FROM staff_logs WHERE entity_type = 'system_settings' ORDER BY id DESC LIMIT 5").all());
    expect(rows).toContain('smtp_password');
    expect(rows).not.toContain('pw-12345-secret');
    const removed = await put({ values: {}, clear_smtp_password: true });
    expect(removed.body.data.smtp_password_set).toBe(false);
    await put({ values: {}, smtp_password: 'pw-12345-secret' });
  });

  it('validates, and the generic endpoint cannot bypass it', async () => {
    expect((await put({ values: { smtp_host: 'https://smtp.example.org' } })).status).toBe(400);
    expect((await put({ values: { smtp_port: '99999' } })).status).toBe(400);
    expect((await put({ values: { smtp_from: 'not-an-address' } })).status).toBe(400);
    for (const key of ['smtp_host', 'smtp_pass_enc']) {
      expect((await request(app).put('/api/settings').set(a).send({ [key]: 'x' })).status, key).toBe(400);
    }
  });

  it('only the admin can change it', async () => {
    expect((await request(app).put('/api/system/config').send({ values: SMTP })).status).toBe(401);
  });
});

describe('sending over SMTP', () => {
  it('the test email goes out through the configured server', async () => {
    const res = await testEmail();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sent: true, to: 'owner@example.com' });
    expect(smtpSendMail).toHaveBeenCalledTimes(1);
    expect(smtpSendMail.mock.calls[0][0]).toMatchObject({ from: 'Shop <shop@example.org>', to: 'owner@example.com', subject: expect.stringContaining('test email') });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.org', port: 465, secure: true, auth: { user: 'shop@example.org', pass: 'pw-12345-secret' } }));
  });

  it('joins a recipient list and passes attachments through', async () => {
    await mailService.sendMail({ to: ['a@x.com', 'b@y.com'], subject: 'S', text: 'T', attachments: [{ filename: 'f.bin', path: '/tmp/f.bin' }, { filename: 'g.txt', content: 'hi' }] });
    expect(smtpSendMail.mock.calls[0][0]).toMatchObject({ to: 'a@x.com, b@y.com', attachments: [{ filename: 'f.bin', path: '/tmp/f.bin' }, { filename: 'g.txt', content: 'hi' }] });
  });

  it('environment variables (Railway "Variables") work when nothing is saved in Settings', async () => {
    await clearSmtp();
    expect(mailService.isConfigured()).toBe(false);
    process.env.SMTP_HOST = 'smtp.legacy.example.com';
    process.env.SMTP_USER = 'legacy@example.com';
    process.env.SMTP_PASS = 'legacy-pw';
    expect(mailService.isConfigured()).toBe(true);
    expect(JSON.stringify((await getConfig()).body)).not.toContain('legacy-pw');
    await testEmail();
    expect(nodemailer.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'smtp.legacy.example.com', auth: { user: 'legacy@example.com', pass: 'legacy-pw' } }));
    await put({ values: SMTP, smtp_password: 'pw-12345-secret' });
  });

  it('a missing server explains where to set it up', async () => {
    await clearSmtp();
    const res = await testEmail();
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Settings');
    expect(smtpSendMail).not.toHaveBeenCalled();
    await put({ values: SMTP, smtp_password: 'pw-12345-secret' });
  });
});

describe('SMTP failures become advice', () => {
  const fail = async (err) => { smtpSendMail.mockRejectedValueOnce(err); return testEmail(); };

  it('wrong password', async () => {
    const res = await fail(new Error('535 5.7.8 Username and Password not accepted'));
    expect(res.status).toBe(502);
    expect(res.body.error.message).toContain('App Password');
  });

  it('cannot connect: explains the Railway plan limit without pointing at a removed alternative', async () => {
    const res = await fail(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
    expect(res.body.error.message).toContain('Railway');
    expect(res.body.error.message).toContain('blocked');
    expect(res.body.error.message).not.toMatch(/resend/i);
  });

  it('unknown host and TLS mismatch', async () => {
    expect((await fail(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).body.error.message).toContain('could not be found');
    expect((await fail(new Error('wrong version number'))).body.error.message).toContain('port 587');
  });
});

describe('leftovers from Resend are removed by the migration', () => {
  it('deletes the old method, sender and (encrypted) API key rows, and leaves everything else', () => {
    const dbFile = path.join(os.tmpdir(), `utpos-migrate-${process.pid}-${Date.now()}.db`);
    const run = () => execFileSync(process.execPath, [path.join(__dirname, '..', 'src', 'db', 'migrate.js')], {
      env: { ...process.env, NODE_ENV: 'test', DATABASE_PATH: dbFile }, stdio: 'pipe',
    });
    try {
      run();                                                         // creates the schema
      const Database = require('better-sqlite3');
      const d = new Database(dbFile);
      d.prepare("INSERT INTO settings (key, value) VALUES ('mail_provider', 'resend'), ('resend_from', 'x@y.z'), ('resend_api_key_enc', 'enc:v1:abc'), ('smtp_host', 'smtp.keep.me')").run();
      d.close();
      run();                                                         // what happens on the next deploy
      const e = new Database(dbFile, { readonly: true });
      const keys = e.prepare('SELECT key FROM settings ORDER BY key').all().map((r) => r.key);
      e.close();
      expect(keys).not.toContain('mail_provider');
      expect(keys).not.toContain('resend_from');
      expect(keys).not.toContain('resend_api_key_enc');
      expect(keys).toContain('smtp_host');
    } finally {
      for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile + s, { force: true });
    }
  });
});
