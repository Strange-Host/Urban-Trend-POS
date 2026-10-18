const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const systemConfig = require('../src/services/systemConfig.service');
const mailService = require('../src/services/mail.service');
const backupService = require('../src/services/backup.service');
const alerting = require('../src/services/alerting.service');

// Email sent over HTTPS through Resend instead of SMTP - the route that works on hosts that block
// outgoing SMTP ports (Railway Free/Trial/Hobby). axios.post is mocked: nothing leaves the machine.

let a; let post; let smtpSendMail;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const put = (body) => request(app).put('/api/system/config').set(a).send(body);
const getConfig = () => request(app).get('/api/system/config').set(a);
const testEmail = (to = 'owner@example.com') => request(app).post('/api/system/test-email').set(a).send({ to });
const ENV_KEYS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'RESEND_API_KEY', 'RESEND_FROM', 'MAIL_PROVIDER', 'BACKUP_EMAIL_TO'];
const KEY = 're_test_1234567890abcdef';

const apiError = (status, message) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { statusCode: status, name: 'error', message } } });
const lastBody = () => post.mock.calls[post.mock.calls.length - 1][1];
const lastConfig = () => post.mock.calls[post.mock.calls.length - 1][2];

beforeAll(async () => {
  a = auth(await loginAsAdmin());
  smtpSendMail = vi.fn().mockResolvedValue({});
  vi.spyOn(nodemailer, 'createTransport').mockImplementation(() => ({ sendMail: smtpSendMail }));
});
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  smtpSendMail.mockClear();
  post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { id: 'em_123' } });
});
afterEach(() => post.mockRestore());
afterAll(async () => {
  await put({ values: { mail_provider: '', resend_from: '' }, clear_resend_api_key: true });
  db.prepare("DELETE FROM settings WHERE key = 'backup_email_recipients'").run();
  cleanupTestDb();
});

describe('choosing Resend and saving its key', () => {
  it('stores the API key encrypted and never sends it back to the browser', async () => {
    const res = await put({ values: { mail_provider: 'resend' }, resend_api_key: `  ${KEY}  ` });
    expect(res.status).toBe(200);
    expect(res.body.data.effective.mail_provider).toBe('resend');
    expect(res.body.data.resend_api_key_set).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(KEY);

    const stored = db.prepare("SELECT value FROM settings WHERE key = 'resend_api_key_enc'").get().value;
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(stored).not.toContain(KEY);
    expect(systemConfig.resend().apiKey).toBe(KEY);                                    // trimmed, decrypts back

    expect(JSON.stringify((await getConfig()).body)).not.toContain(KEY);
    const all = (await request(app).get('/api/settings').set(a)).body.data;
    expect(all.resend_api_key_enc).toBeUndefined();                                    // generic settings endpoint hides it too
    expect(all.smtp_pass_enc).toBeUndefined();
  });

  it('the audit trail records that the key changed, never the key', async () => {
    try {
      await put({ values: {}, resend_api_key: `${KEY}-rotated` });
      const rows = JSON.stringify(db.prepare("SELECT changes FROM staff_logs WHERE entity_type = 'system_settings' ORDER BY id DESC LIMIT 3").all());
      expect(rows).toContain('resend_api_key');
      expect(rows).not.toContain('re_test_');
    } finally {
      await put({ values: {}, resend_api_key: KEY });                                  // always restore, so a failure here cannot cascade
    }
  });

  it('leaves the saved key alone when the field is blank, and can remove it', async () => {
    await put({ values: { resend_from: '' }, resend_api_key: '' });
    expect(systemConfig.resend().apiKey).toBe(KEY);
    const removed = await put({ values: {}, clear_resend_api_key: true });
    expect(removed.body.data.resend_api_key_set).toBe(false);
    expect(mailService.isConfigured()).toBe(false);
    await put({ values: {}, resend_api_key: KEY });
  });

  it('refuses an unknown method or a bad "send from" address, and the generic endpoint cannot bypass it', async () => {
    expect((await put({ values: { mail_provider: 'pigeon' } })).status).toBe(400);
    expect((await put({ values: { resend_from: 'not-an-address' } })).status).toBe(400);
    for (const key of ['mail_provider', 'resend_from', 'resend_api_key_enc']) {
      expect((await request(app).put('/api/settings').set(a).send({ [key]: 'x' })).status, key).toBe(400);
    }
  });

  it('only the admin can change it', async () => {
    expect((await request(app).put('/api/system/config').send({ values: { mail_provider: 'resend' } })).status).toBe(401);
  });
});

describe('sending through Resend', () => {
  it('the test email goes out as one HTTPS call to Resend - SMTP is never touched', async () => {
    const res = await testEmail();
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sent: true, to: 'owner@example.com' });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('https://api.resend.com/emails');
    expect(lastConfig().headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(lastBody()).toMatchObject({ from: 'Urban Trends POS <onboarding@resend.dev>', to: ['owner@example.com'], subject: expect.stringContaining('test email') });
    expect(lastBody().attachments).toBeUndefined();
    expect(smtpSendMail).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).not.toHaveBeenCalledWith(expect.objectContaining({ host: expect.anything() }));
  });

  it('uses the saved "send from" address (for a verified domain) instead of the default', async () => {
    await put({ values: { resend_from: 'Urban Trends <backups@urbantrends.co.ke>' } });
    await testEmail();
    expect(lastBody().from).toBe('Urban Trends <backups@urbantrends.co.ke>');
    await put({ values: { resend_from: '' } });
    await testEmail();
    expect(lastBody().from).toContain('onboarding@resend.dev');
  });

  it('splits a comma-separated recipient list and attaches files as base64', async () => {
    const file = path.join(os.tmpdir(), `resend-attach-${process.pid}.bin`);
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253]);
    fs.writeFileSync(file, bytes);
    try {
      await mailService.sendMail({ to: 'a@x.com, b@y.com ,', subject: 'S', text: 'T', attachments: [{ filename: 'backup.db.gz.enc', path: file }] });
    } finally { fs.rmSync(file, { force: true }); }
    expect(lastBody().to).toEqual(['a@x.com', 'b@y.com']);
    expect(lastBody().attachments).toEqual([{ filename: 'backup.db.gz.enc', content: bytes.toString('base64') }]);
    expect(lastConfig().maxBodyLength).toBe(Infinity);                                 // a multi-MB body must not be cut off by axios
  });

  it('refuses an attachment too big for Resend before uploading anything', async () => {
    const big = Buffer.alloc(29 * 1024 * 1024);
    await expect(mailService.sendMail({ to: 'a@x.com', subject: 'S', text: 'T', attachments: [{ filename: 'big.bin', content: big }] }))
      .rejects.toMatchObject({ statusCode: 413 });
    expect(post).not.toHaveBeenCalled();
  });

  it('a missing key explains where to put it', async () => {
    await put({ values: {}, clear_resend_api_key: true });
    const res = await testEmail();
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Settings');
    expect(post).not.toHaveBeenCalled();
    await put({ values: {}, resend_api_key: KEY });
  });
});

describe('Resend failures become advice', () => {
  const fail = async (err) => { post.mockRejectedValueOnce(err); return testEmail(); };

  it('wrong key', async () => {
    const res = await fail(apiError(401, 'API key is invalid'));
    expect(res.status).toBe(502);
    expect(res.body.error.message).toContain('API key');
    expect(res.body.error.message).toContain('re_');
  });

  it('free account sending to someone other than its sign-up address', async () => {
    const res = await fail(apiError(403, 'You can only send testing emails to your own email address (me@gmail.com). To send emails to other recipients, please verify a domain at resend.com/domains.'));
    expect(res.status).toBe(502);
    expect(res.body.error.message).toContain('sign-up address');
    expect(res.body.error.message).toContain('verify a domain');
  });

  it('a "send from" address on an unverified domain', async () => {
    const res = await fail(apiError(403, 'The shop.com domain is not verified.'));
    expect(res.body.error.message).toContain('not verified');
    expect(res.body.error.message).toContain('Domains');
  });

  it('rate limit, invalid payload, no internet, timeout', async () => {
    expect((await fail(apiError(429, 'Too many requests'))).body.error.message).toContain('100 per day');
    expect((await fail(apiError(422, 'Invalid `to` field.'))).body.error.message).toContain('Invalid `to` field.');
    expect((await fail(Object.assign(new Error('getaddrinfo ENOTFOUND api.resend.com'), { code: 'ENOTFOUND' }))).body.error.message).toContain('api.resend.com');
    expect((await fail(Object.assign(new Error('timeout of 45000ms exceeded'), { code: 'ECONNABORTED' }))).body.error.message).toContain('too long');
  });
});

describe('backups and alerts use whichever method is selected', () => {
  beforeAll(async () => {
    await request(app).put('/api/settings').set(a).send({ backup_email_recipients: 'owner@example.com, ops@example.com' });
  });

  it('the emailed backup is an encrypted attachment sent through Resend to every recipient', async () => {
    expect(backupService.emailConfigured()).toBe(true);
    const result = await backupService.runBackupAndEmail();
    expect(post).toHaveBeenCalledTimes(1);
    expect(lastBody().to).toEqual(['owner@example.com', 'ops@example.com']);
    expect(lastBody().subject).toContain(result.file);
    expect(lastBody().attachments).toHaveLength(1);
    expect(lastBody().attachments[0].filename).toBe(`${result.file}.gz.enc`);
    expect(Buffer.from(lastBody().attachments[0].content, 'base64').length).toBeGreaterThan(100);
    expect(smtpSendMail).not.toHaveBeenCalled();
    expect(backupService.getLastEmailStatus()).toMatchObject({ status: 'sent', file: result.file });
  });

  it('a Resend failure is recorded as a failed backup email with the advice attached', async () => {
    post.mockRejectedValueOnce(apiError(401, 'API key is invalid'));
    await expect(backupService.runBackupAndEmail()).rejects.toMatchObject({ statusCode: 502 });
    const status = backupService.getLastEmailStatus();
    expect(status.status).toBe('failed');
    expect(status.error).toContain('API key');
  });

  it('failure alerts also go through Resend, and never throw', async () => {
    expect(await alerting.sendAlert({ subject: 'Test alert', message: 'hello' })).toBe(true);
    expect(lastBody().subject).toBe('[Urban Trends POS alert] Test alert');
    expect(lastBody().to).toEqual(['owner@example.com', 'ops@example.com']);
    post.mockRejectedValueOnce(apiError(429, 'Too many requests'));
    expect(await alerting.sendAlert({ subject: 'Again', message: 'x' })).toBe(false);
  });

  it('switching back to SMTP sends the same backup over SMTP again', async () => {
    await put({ values: { mail_provider: 'smtp', smtp_host: 'smtp.example.org', smtp_port: '465', smtp_secure: '1', smtp_user: 'shop@example.org', smtp_from: 'shop@example.org' }, smtp_password: 'pw-123456' });
    await backupService.runBackupAndEmail();
    expect(post).not.toHaveBeenCalled();
    expect(smtpSendMail).toHaveBeenCalledTimes(1);
    expect(smtpSendMail.mock.calls[0][0]).toMatchObject({ from: 'shop@example.org', to: 'owner@example.com, ops@example.com' });
    expect(smtpSendMail.mock.calls[0][0].attachments[0].filename).toMatch(/\.gz\.enc$/);
    await put({ values: { mail_provider: 'resend', smtp_host: '', smtp_port: '', smtp_secure: '', smtp_user: '', smtp_from: '' }, clear_smtp_password: true });
  });
});

describe('environment variables (Railway "Variables") work without saving anything in Settings', () => {
  beforeAll(async () => { await put({ values: { mail_provider: '' }, clear_resend_api_key: true }); });
  afterAll(async () => { await put({ values: { mail_provider: 'resend' }, resend_api_key: KEY }); });

  it('RESEND_API_KEY alone switches the method to Resend', async () => {
    expect(mailService.provider()).toBe('smtp');
    expect(mailService.isConfigured()).toBe(false);
    process.env.RESEND_API_KEY = 're_from_env_key';
    process.env.RESEND_FROM = 'Shop <shop@verified.example>';
    expect(mailService.provider()).toBe('resend');
    expect(mailService.isConfigured()).toBe(true);
    const cfg = (await getConfig()).body.data;
    expect(cfg.resend_api_key_set).toBe(true);
    expect(cfg.resend_source).toBe('environment');
    expect(JSON.stringify(cfg)).not.toContain('re_from_env_key');
    await testEmail();
    expect(lastConfig().headers.Authorization).toBe('Bearer re_from_env_key');
    expect(lastBody().from).toBe('Shop <shop@verified.example>');
  });

  it('a saved Settings key wins over the environment, and MAIL_PROVIDER=smtp forces SMTP', async () => {
    process.env.RESEND_API_KEY = 're_from_env_key';
    await put({ values: {}, resend_api_key: KEY });
    await testEmail();
    expect(lastConfig().headers.Authorization).toBe(`Bearer ${KEY}`);
    await put({ values: {}, clear_resend_api_key: true });

    process.env.MAIL_PROVIDER = 'smtp';
    expect(mailService.provider()).toBe('smtp');
    process.env.SMTP_HOST = 'smtp.legacy.example.com';
    delete process.env.MAIL_PROVIDER;
    expect(mailService.provider()).toBe('smtp');                                       // existing SMTP installs are never silently switched
  });
});
