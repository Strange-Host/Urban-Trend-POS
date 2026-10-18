const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

// Backups that leave the server (the emailed copies) are compressed and then encrypted with AES-256-GCM, so a copy
// sitting in someone's inbox, phone or a lost laptop is unreadable without the passphrase, and any tampering is detected.
//
// File layout:  "UTBK1\n" | salt (16) | iv (12) | encrypted gzip data ... | auth tag (16)
// Copies that LEAVE the server are encrypted with BACKUP_PASSPHRASE only (passphraseForOffsite) - it must be set as an
// environment variable (Railway -> Variables), never saved in the database, because the database is what gets backed up.
// Why not fall back to ENCRYPTION_KEY: that key lives in backend/.env on the same machine, so if the machine is lost
// the key is lost with it and every off-site copy becomes unreadable. passphraseFromEnv() still accepts it, so
// backups made under the old fallback can still be opened by scripts/restore-backup.js.
//
// To open one:  cd backend && node scripts/restore-backup.js path/to/backup.db.gz.enc

const MAGIC = Buffer.from('UTBK1\n');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;

function passphraseFromEnv(env = process.env) {
  if (env.BACKUP_PASSPHRASE && env.BACKUP_PASSPHRASE.length >= 12) return { value: env.BACKUP_PASSPHRASE, source: 'BACKUP_PASSPHRASE' };
  if (env.ENCRYPTION_KEY) {
    return { value: crypto.createHmac('sha256', env.ENCRYPTION_KEY).update('urban-trends-backup-v1').digest('hex'), source: 'ENCRYPTION_KEY' };
  }
  throw new Error('No backup passphrase: set BACKUP_PASSPHRASE (12+ characters) or ENCRYPTION_KEY.');
}

/**
 * The passphrase for a copy that leaves the server. BACKUP_PASSPHRASE only, 12+ characters, and a clear error
 * (rather than a silent fallback to another key) when it is missing or too short.
 */
function passphraseForOffsite(env = process.env) {
  const value = env.BACKUP_PASSPHRASE;
  if (!value) {
    throw new Error('BACKUP_PASSPHRASE is not set. Off-site backups are encrypted with it, so add it as an environment variable (Railway -> Variables): a phrase of 12+ characters that you also keep in a password manager. Without it, no copy is sent.');
  }
  if (value.length < 12) {
    throw new Error(`BACKUP_PASSPHRASE is too short (${value.length} characters). Use 12 or more.`);
  }
  return { value, source: 'BACKUP_PASSPHRASE' };
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32);
}

/** src -> gzip -> AES-256-GCM -> dest. */
async function encryptFile(src, dest, passphrase) {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const out = fs.createWriteStream(dest, { mode: 0o600 }); // owner-only, even in a shared temp folder
  out.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 9 }), cipher, out, { end: false });
  out.end(cipher.getAuthTag());
  await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
  return dest;
}

/** dest <- gunzip <- AES-256-GCM <- src. Throws if the passphrase is wrong or the file was altered. */
async function decryptFile(src, dest, passphrase) {
  const size = fs.statSync(src).size;
  if (size < HEADER_LEN + TAG_LEN) throw new Error('This is not an encrypted Urban Trends backup (file too small).');
  const fd = fs.openSync(src, 'r');
  let head; let tag;
  try {
    head = Buffer.alloc(HEADER_LEN); fs.readSync(fd, head, 0, HEADER_LEN, 0);
    tag = Buffer.alloc(TAG_LEN); fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
  } finally { fs.closeSync(fd); }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This is not an encrypted Urban Trends backup (wrong file type).');
  const salt = head.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = head.subarray(MAGIC.length + SALT_LEN);

  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      fs.createReadStream(src, { start: HEADER_LEN, end: size - TAG_LEN - 1 }),
      decipher, zlib.createGunzip(), fs.createWriteStream(dest, { mode: 0o600 })
    );
  } catch (err) {
    try { fs.unlinkSync(dest); } catch (_) { /* nothing written */ }
    throw new Error('Could not decrypt: the passphrase is wrong, or the file was damaged or changed.');
  }
  return dest;
}

/**
 * Fast sanity check run on every new backup: SQLite's quick_check, plus proof that it is a real POS database
 * (an empty or truncated file can pass quick_check). Cheaper than verifyDatabase, which the trial restore uses.
 */
function quickCheck(dbPath) {
  const Database = require('better-sqlite3');
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const result = db.pragma('quick_check', { simple: true });
    const hasUsers = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get());
    if (result !== 'ok') return { ok: false, detail: `quick_check said: ${result}` };
    if (!hasUsers) return { ok: false, detail: 'it has no users table, so it is not a POS database' };
    return { ok: true, detail: 'ok' };
  } catch (err) {
    return { ok: false, detail: err.message };
  } finally {
    if (db) { try { db.close(); } catch (_) { /* already closed */ } }
  }
}

/** Proves an encrypted copy can really be opened again with this passphrase and holds a sound database. */
async function verifyEncryptedBackup(encPath, passphrase) {
  const tmp = path.join(os.tmpdir(), `utbk-verify-${crypto.randomBytes(6).toString('hex')}.db`);
  try {
    await decryptFile(encPath, tmp, passphrase);
    const r = quickCheck(tmp);
    if (!r.ok) throw new Error(`The encrypted copy decrypts but the database inside is not sound (${r.detail}).`);
    return r;
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(tmp + suffix, { force: true });
  }
}

/** Opens a restored database read-only and checks it is sound. Returns a summary for the "trial restore". */
function verifyDatabase(dbPath) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    const fkProblems = db.pragma('foreign_key_check').length;
    const count = (t) => { try { return db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch (_) { return null; } };
    const tables = Object.fromEntries(['users', 'products', 'sales', 'leads', 'orders', 'customers'].map((t) => [t, count(t)]));
    const newest = (() => { try { return db.prepare('SELECT MAX(created_at) m FROM sales').get().m; } catch (_) { return null; } })();
    return { ok: integrity === 'ok' && fkProblems === 0, integrity, foreignKeyProblems: fkProblems, tables, newestSale: newest };
  } finally { db.close(); }
}

module.exports = { encryptFile, decryptFile, verifyDatabase, passphraseFromEnv, passphraseForOffsite, quickCheck, verifyEncryptedBackup };
