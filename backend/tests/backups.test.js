const fs = require('fs');
const os = require('os');
const path = require('path');
const nodemailer = require('nodemailer');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const backupService = require('../src/services/backup.service');
const alerting = require('../src/services/alerting.service');
const { decryptFile, verifyDatabase } = require('../src/utils/backupCrypto');

// Scheduling is driven through tick(now) so no test waits on a real timer. nodemailer is mocked: nothing is sent.

let a; let smtpSendMail;
const PASS = 'a passphrase of enough length';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const HOUR = 60 * 60 * 1000;
const dbFiles = () => fs.readdirSync(backupService.BACKUP_DIR).filter((f) => f.endsWith('.db'));
const notices = (type) => db.prepare('SELECT * FROM notifications WHERE type = ?').all(type);
const tempEncFiles = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('urban_trends-') && f.endsWith('.gz.enc'));
const alertMails = () => smtpSendMail.mock.calls.filter((c) => /\[Urban Trends POS alert\]/.test(c[0].subject));

function reset() {
  fs.mkdirSync(backupService.BACKUP_DIR, { recursive: true });
  for (const f of dbFiles()) fs.rmSync(path.join(backupService.BACKUP_DIR, f), { force: true });
  db.prepare("DELETE FROM settings WHERE key IN ('last_local_backup', 'last_backup_email')").run();
  db.prepare('DELETE FROM notifications').run();
  smtpSendMail.mockReset().mockResolvedValue({});
}
const configureEmail = async (on) => {
  await request(app).put('/api/system/config').set(a).send(on
    ? { values: { smtp_host: 'smtp.example.org', smtp_port: '587', smtp_user: 'shop@example.org' }, smtp_password: 'pw' }
    : { values: { smtp_host: '', smtp_port: '', smtp_user: '' }, clear_smtp_password: true });
  await request(app).put('/api/settings').set(a).send({ backup_email_recipients: on ? 'owner@example.com, ops@example.com' : '' });
};

beforeAll(async () => {
  a = auth(await loginAsAdmin());
  smtpSendMail = vi.fn().mockResolvedValue({});
  vi.spyOn(nodemailer, 'createTransport').mockImplementation(() => ({ sendMail: smtpSendMail }));
});
beforeEach(() => { reset(); delete process.env.BACKUP_PASSPHRASE; delete process.env.BACKUP_EMAIL_TO; });
// Only spies made through spy() are undone after each test - the mocked mail transport must stay in place.
const spies = [];
const spy = (obj, method) => { const s = vi.spyOn(obj, method); spies.push(s); return s; };
afterEach(() => { while (spies.length) spies.pop().mockRestore(); });
afterAll(async () => { await configureEmail(false); reset(); cleanupTestDb(); });

describe('a local backup is checked, protected and recorded', () => {
  it('writes a sound, owner-only copy and records when it succeeded', async () => {
    const r = await backupService.runBackup();
    expect(fs.existsSync(r.path)).toBe(true);
    expect(verifyDatabase(r.path).ok).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(r.path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(backupService.BACKUP_DIR).mode & 0o777).toBe(0o700);
    }
    expect(backupService.getLastLocalStatus()).toMatchObject({ status: 'ok', file: r.file, error: null });
    expect(backupService.getLastLocalStatus().lastSuccessAt).toBeTruthy();
  });

  it('discards a backup that fails its integrity check, keeps the good ones, and says so', async () => {
    const good = await backupService.runBackup();
    spy(db, 'backup').mockImplementation(async (dest) => { fs.writeFileSync(dest, 'this is not a database, it is junk'); });

    await expect(backupService.runBackup()).rejects.toThrow(/integrity check/);
    expect(dbFiles()).toEqual([good.file]);                               // the junk file is gone, the good one is untouched
    const s = backupService.getLastLocalStatus();
    expect(s.status).toBe('failed');
    expect(s.error).toMatch(/discarded/);
    expect(s.lastSuccessAt).toBeTruthy();                                 // the last GOOD time is still known
  });

  it('a failed backup never pushes a good one out of the retention window', async () => {
    for (let i = 0; i < 3; i++) await backupService.runBackup();
    spy(db, 'backup').mockImplementation(async (dest) => { fs.writeFileSync(dest, 'junk'); });
    await expect(backupService.runBackup()).rejects.toThrow();
    expect(dbFiles()).toHaveLength(3);
  });

  it('two requests at once share one backup instead of snapshotting twice', async () => {
    const [x, y] = await Promise.all([backupService.runBackup(), backupService.runBackup()]);
    expect(x.file).toBe(y.file);
    expect(dbFiles()).toHaveLength(1);
  });
});

describe('off-site copies', () => {
  beforeEach(async () => { await configureEmail(true); });
  afterAll(async () => { await configureEmail(false); });

  it('are not sent without BACKUP_PASSPHRASE - the server key is no longer a silent fallback', async () => {
    expect(process.env.ENCRYPTION_KEY).toBeTruthy();                      // present, and must NOT be used
    expect(backupService.passphraseStatus().passphraseSet).toBe(false);
    await expect(backupService.runBackupAndEmail()).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('BACKUP_PASSPHRASE is not set') });
    expect(smtpSendMail).not.toHaveBeenCalled();
    expect(backupService.getLastEmailStatus()).toMatchObject({ status: 'failed', error: expect.stringContaining('BACKUP_PASSPHRASE') });
    expect(backupService.getLastLocalStatus().status).toBe('ok');         // the local backup still happened
  });

  it('refuse a passphrase that is too short rather than quietly using something else', async () => {
    process.env.BACKUP_PASSPHRASE = 'short';
    await expect(backupService.runBackupAndEmail()).rejects.toThrow(/too short/);
    expect(smtpSendMail).not.toHaveBeenCalled();
  });

  it('go out encrypted, to everyone, and the attachment really decrypts into a sound database', async () => {
    process.env.BACKUP_PASSPHRASE = PASS;
    let attachment;
    smtpSendMail.mockImplementation(async (msg) => { attachment = fs.readFileSync(msg.attachments[0].path); return {}; });
    const r = await backupService.runBackupAndEmail();

    const msg = smtpSendMail.mock.calls[0][0];
    expect(msg.to).toBe('owner@example.com, ops@example.com');
    expect(msg.attachments[0].filename).toBe(`${r.file}.gz.enc`);
    expect(msg.text).toContain('ENCRYPTION_KEY');                         // tells the reader the server key is kept separately
    expect(msg.text).not.toContain('if no passphrase was set');

    const enc = path.join(os.tmpdir(), `check-${process.pid}.enc`); const out = path.join(os.tmpdir(), `check-${process.pid}.db`);
    fs.writeFileSync(enc, attachment);
    try {
      await decryptFile(enc, out, PASS);
      expect(verifyDatabase(out).ok).toBe(true);
    } finally { fs.rmSync(enc, { force: true }); fs.rmSync(out, { force: true }); }
    expect(backupService.getLastEmailStatus()).toMatchObject({ status: 'sent', file: r.file, error: null });
  });

  it('leave no temporary copy behind, whether sending works or not', async () => {
    process.env.BACKUP_PASSPHRASE = PASS;
    const before = tempEncFiles().length;
    await backupService.runBackupAndEmail();
    smtpSendMail.mockRejectedValueOnce(new Error('535 Username and Password not accepted'));
    await expect(backupService.runBackupAndEmail()).rejects.toMatchObject({ statusCode: 502 });
    await new Promise((r) => setTimeout(r, 50));                          // the cleanup is fire-and-forget
    expect(tempEncFiles().length).toBe(before);
  });

  it('are not sent if the encrypted copy cannot be opened again', async () => {
    process.env.BACKUP_PASSPHRASE = PASS;
    const crypto = require('../src/utils/backupCrypto');
    spy(crypto, 'verifyEncryptedBackup').mockRejectedValue(new Error('Could not decrypt: the passphrase is wrong, or the file was damaged or changed.'));
    await expect(backupService.runBackupAndEmail()).rejects.toThrow(/Could not decrypt/);
    expect(smtpSendMail).not.toHaveBeenCalled();
  });
});

describe('the schedule survives restarts (it is remembered, not held in a timer)', () => {
  it('isDue: waits out the interval, and pauses an hour after a failure', () => {
    const now = 10 * HOUR;
    expect(backupService.isDue({ lastSuccessMs: 0 }, 6 * HOUR, now)).toBe(true);                       // never done
    expect(backupService.isDue({ lastSuccessMs: now - 5 * HOUR }, 6 * HOUR, now)).toBe(false);
    expect(backupService.isDue({ lastSuccessMs: now - 7 * HOUR }, 6 * HOUR, now)).toBe(true);
    expect(backupService.isDue({ lastSuccessMs: now - 7 * HOUR, lastAttemptMs: now - 10 * 60 * 1000, lastStatus: 'failed' }, 6 * HOUR, now)).toBe(false);
    expect(backupService.isDue({ lastSuccessMs: now - 7 * HOUR, lastAttemptMs: now - 2 * HOUR, lastStatus: 'failed' }, 6 * HOUR, now)).toBe(true);
  });

  it('the first pass after a boot backs up at once when none exists; later passes do nothing until 6h are up', async () => {
    const t0 = Date.now();
    expect(await backupService.tick(t0)).toEqual({ local: true, offsite: false });
    expect(dbFiles()).toHaveLength(1);

    // "restart": a brand new pass has no timers or in-memory state to go on, only what was saved
    expect(await backupService.tick(t0 + 60 * 1000)).toEqual({ local: false, offsite: false });
    expect(await backupService.tick(t0 + 5 * HOUR)).toEqual({ local: false, offsite: false });
    expect(await backupService.tick(t0 + 6 * HOUR + 60 * 1000)).toEqual({ local: true, offsite: false });
    expect(dbFiles()).toHaveLength(2);
  });

  it('backups made before status was recorded still count', async () => {
    await backupService.runBackup();
    db.prepare("DELETE FROM settings WHERE key = 'last_local_backup'").run();   // as on a server upgraded from the old code
    expect(await backupService.tick(Date.now() + 60 * 1000)).toEqual({ local: false, offsite: false });
  });

  it('with email set up, one pass makes ONE backup and sends that same file off-site', async () => {
    await configureEmail(true);
    process.env.BACKUP_PASSPHRASE = PASS;
    const t0 = Date.now();
    expect(await backupService.tick(t0)).toEqual({ local: true, offsite: true });
    expect(dbFiles()).toHaveLength(1);
    expect(smtpSendMail).toHaveBeenCalledTimes(1);
    expect(smtpSendMail.mock.calls[0][0].subject).toContain(dbFiles()[0]);

    expect(await backupService.tick(t0 + 7 * HOUR)).toEqual({ local: true, offsite: false });   // local again after 6h, off-site only after 24h
    expect(await backupService.tick(t0 + 25 * HOUR)).toEqual({ local: true, offsite: true });
    await configureEmail(false);
  });

  it('does not try off-site at all while email is not set up', async () => {
    expect((await backupService.tick(Date.now())).offsite).toBe(false);
    expect(smtpSendMail).not.toHaveBeenCalled();
  });
});

describe('failures are retried hourly, announced once, and the notice clears when fixed', () => {
  beforeEach(async () => { await configureEmail(true); process.env.BACKUP_PASSPHRASE = PASS; });
  afterAll(async () => { await configureEmail(false); });

  it('off-site failing: one in-app notice and one email, however many retries', async () => {
    const t0 = Date.now();
    smtpSendMail.mockImplementation(async (msg) => { if (/backup \(encrypted\)/.test(msg.subject)) throw new Error('535 Username and Password not accepted'); return {}; });

    expect((await backupService.tick(t0)).offsite).toBe(true);
    expect(notices('backup_offsite_failed')).toHaveLength(1);
    expect(notices('backup_offsite_failed')[0]).toMatchObject({ severity: 'urgent', title: 'Off-site backup copy failed' });
    expect(alertMails()).toHaveLength(1);

    expect((await backupService.tick(t0 + 10 * 60 * 1000)).offsite).toBe(false);                 // paused: not hammering the server
    expect((await backupService.tick(t0 + 61 * 60 * 1000)).offsite).toBe(true);                  // hourly retry...
    expect((await backupService.tick(t0 + 3 * HOUR)).offsite).toBe(true);
    expect(notices('backup_offsite_failed')).toHaveLength(1);                                    // ...without piling up notices
    expect(alertMails()).toHaveLength(1);                                                        // ...or alert emails

    expect((await backupService.tick(t0 + 25 * HOUR)).offsite).toBe(true);                       // still broken a day later: remind once
    expect(alertMails()).toHaveLength(2);

    // fixed: the next success sends the copy, clears the notice's lock, and a later failure notifies again
    smtpSendMail.mockReset().mockResolvedValue({});
    expect((await backupService.tick(t0 + 27 * HOUR)).offsite).toBe(true);
    expect(backupService.getLastEmailStatus().status).toBe('sent');
    expect(db.prepare("SELECT dedupe_key FROM notifications WHERE type = 'backup_offsite_failed'").get().dedupe_key).toBeNull();
  });

  it('a missing passphrase surfaces as that failure too, so it is not silent', async () => {
    delete process.env.BACKUP_PASSPHRASE;
    await backupService.tick(Date.now());
    expect(notices('backup_offsite_failed')[0].body).toContain('BACKUP_PASSPHRASE');
  });

  it('a local backup failing raises an in-app notice even when email is not set up', async () => {
    await configureEmail(false);
    spy(db, 'backup').mockRejectedValue(new Error('SQLITE_FULL: database or disk is full'));
    const ran = await backupService.tick(Date.now());
    expect(ran).toEqual({ local: true, offsite: false });                                        // and no off-site attempt on top of a failed local one
    expect(notices('backup_failed')).toHaveLength(1);
    expect(notices('backup_failed')[0].body).toContain('disk is full');
    expect(smtpSendMail).not.toHaveBeenCalled();
  });
});

describe('alerts reach the admin bell as well as email', () => {
  it('sendAlert creates one notice per active admin and reports whether the EMAIL went out', async () => {
    const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND is_active = 1").get().c;
    expect(await alerting.alertInventoryDrift([{ product_name: 'Tee', sku: 'T-1', store_id: 1, cached_quantity: 5, ledger_quantity: 4, drift: 1 }])).toBe(false); // email not set up
    expect(notices('inventory_drift')).toHaveLength(admins);

    await alerting.alertInventoryDrift([{ product_name: 'Tee', sku: 'T-1', store_id: 1, cached_quantity: 5, ledger_quantity: 3, drift: 2 }]);
    expect(notices('inventory_drift')).toHaveLength(admins);                                    // de-duplicated while unresolved

    alerting.resolveNotices('inventory_drift');
    await alerting.alertInventoryDrift([{ product_name: 'Tee', sku: 'T-1', store_id: 1, cached_quantity: 9, ledger_quantity: 3, drift: 6 }]);
    expect(notices('inventory_drift')).toHaveLength(admins * 2);                                // after resolution it notifies again
  });

  it('the Backups screen data reports last local result, off-site readiness and the passphrase state', async () => {
    await backupService.runBackup();
    const res = await request(app).get('/api/backups').set(a);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ emailConfigured: false, passphraseSet: false, lastLocal: { status: 'ok' } });
    expect(res.body.passphraseProblem).toContain('BACKUP_PASSPHRASE');
    process.env.BACKUP_PASSPHRASE = PASS;
    expect((await request(app).get('/api/backups').set(a)).body.passphraseSet).toBe(true);
    expect((await request(app).get('/api/backups')).status).toBe(401);
  });
});
