const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { encryptFile, decryptFile, verifyDatabase, passphraseFromEnv } = require('../src/utils/backupCrypto');
const { cleanupTestDb } = require('./setup');

afterAll(() => cleanupTestDb());

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utbk-'));
const plain = path.join(dir, 'sample.db');
const enc = path.join(dir, 'sample.db.gz.enc');

beforeAll(() => {
  const d = new Database(plain);
  d.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users (name) VALUES ('Amina'), ('Brian');
          CREATE TABLE sales (id INTEGER PRIMARY KEY, created_at TEXT); INSERT INTO sales (created_at) VALUES ('2026-10-01 10:00:00');`);
  d.close();
});

describe('encrypted backups', () => {
  it('round-trips and the restored database passes the trial-restore check', async () => {
    await encryptFile(plain, enc, 'a long passphrase only I know');
    const raw = fs.readFileSync(enc);
    expect(raw.subarray(0, 5).toString()).toBe('UTBK1');
    expect(raw.includes(Buffer.from('Amina'))).toBe(false);          // the customer data is not readable in the file

    const out = path.join(dir, 'restored.db');
    await decryptFile(enc, out, 'a long passphrase only I know');
    const r = verifyDatabase(out);
    expect(r.ok).toBe(true);
    expect(r.tables.users).toBe(2);
    expect(r.newestSale).toBe('2026-10-01 10:00:00');
  });

  it('refuses a wrong passphrase and leaves nothing behind', async () => {
    const out = path.join(dir, 'wrong.db');
    await expect(decryptFile(enc, out, 'not the passphrase at all')).rejects.toThrow(/passphrase is wrong/);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('detects a file that was changed', async () => {
    const tampered = path.join(dir, 'tampered.enc');
    const buf = fs.readFileSync(enc);
    buf[buf.length - 40] ^= 0xff;
    fs.writeFileSync(tampered, buf);
    await expect(decryptFile(tampered, path.join(dir, 't.db'), 'a long passphrase only I know')).rejects.toThrow();
  });

  it('rejects a file that is not a backup', async () => {
    const junk = path.join(dir, 'junk.enc');
    fs.writeFileSync(junk, Buffer.alloc(200, 7));
    await expect(decryptFile(junk, path.join(dir, 'j.db'), 'x'.repeat(14))).rejects.toThrow(/not an encrypted/);
  });

  it('uses BACKUP_PASSPHRASE when it is long enough, otherwise the server key, and never goes unencrypted', () => {
    expect(passphraseFromEnv({ BACKUP_PASSPHRASE: 'twelve chars!', ENCRYPTION_KEY: 'k' }).source).toBe('BACKUP_PASSPHRASE');
    expect(passphraseFromEnv({ BACKUP_PASSPHRASE: 'short', ENCRYPTION_KEY: 'k'.repeat(40) }).source).toBe('ENCRYPTION_KEY');
    expect(() => passphraseFromEnv({})).toThrow();
  });
});

describe('checks that run on every backup', () => {
  const { quickCheck, passphraseForOffsite, verifyEncryptedBackup } = require('../src/utils/backupCrypto');
  const Database = require('better-sqlite3');
  const pass = 'a long passphrase only I know';

  it('quickCheck accepts a real database and rejects junk, an empty file and a database that is not the POS', () => {
    expect(quickCheck(plain)).toEqual({ ok: true, detail: 'ok' });
    const junk = path.join(dir, 'junk.db'); fs.writeFileSync(junk, 'definitely not sqlite, just text');
    expect(quickCheck(junk).ok).toBe(false);
    const empty = path.join(dir, 'empty.db'); fs.writeFileSync(empty, '');
    expect(quickCheck(empty).ok).toBe(false);
    const other = path.join(dir, 'other.db'); const o = new Database(other); o.exec('CREATE TABLE notes (id INTEGER)'); o.close();
    expect(quickCheck(other)).toMatchObject({ ok: false, detail: expect.stringContaining('users') });
    expect(quickCheck(path.join(dir, 'missing.db')).ok).toBe(false);
  });

  it('passphraseForOffsite wants BACKUP_PASSPHRASE (12+ characters) and never falls back to ENCRYPTION_KEY', () => {
    expect(passphraseForOffsite({ BACKUP_PASSPHRASE: 'twelve chars!' })).toEqual({ value: 'twelve chars!', source: 'BACKUP_PASSPHRASE' });
    expect(() => passphraseForOffsite({ ENCRYPTION_KEY: 'k'.repeat(40) })).toThrow(/BACKUP_PASSPHRASE is not set/);
    expect(() => passphraseForOffsite({ BACKUP_PASSPHRASE: 'short', ENCRYPTION_KEY: 'k'.repeat(40) })).toThrow(/too short/);
  });

  it('verifyEncryptedBackup proves a copy decrypts, and rejects a wrong passphrase or a damaged database inside', async () => {
    await encryptFile(plain, enc, pass);
    expect((await verifyEncryptedBackup(enc, pass)).ok).toBe(true);
    await expect(verifyEncryptedBackup(enc, 'not the passphrase at all')).rejects.toThrow(/passphrase is wrong/);

    const junk = path.join(dir, 'junk2.db'); fs.writeFileSync(junk, 'not a database'); const junkEnc = path.join(dir, 'junk2.enc');
    await encryptFile(junk, junkEnc, pass);                                   // decrypts fine, but what is inside is junk
    await expect(verifyEncryptedBackup(junkEnc, pass)).rejects.toThrow(/not sound/);
  });

  it('leaves no decrypted temp file behind', async () => {
    const left = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('utbk-verify-'));
    const before = left().length;
    await verifyEncryptedBackup(enc, pass);
    await expect(verifyEncryptedBackup(enc, 'wrong passphrase here')).rejects.toThrow();
    expect(left().length).toBe(before);
  });

  it('the encrypted file is owner-only', async () => {
    if (process.platform === 'win32') return;
    await encryptFile(plain, path.join(dir, 'perm.enc'), pass);
    expect(fs.statSync(path.join(dir, 'perm.enc')).mode & 0o777).toBe(0o600);
  });
});
