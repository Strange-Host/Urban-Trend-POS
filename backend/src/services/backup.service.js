const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const backupCrypto = require('../utils/backupCrypto');
const mailService = require('./mail.service');
const db = require('../config/db');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');
const settingsService = require('./settings.service');
const alerting = require('./alerting.service');

// Uses better-sqlite3's native online backup API (SQLite's own backup
// mechanism) rather than a raw file copy — in WAL mode a plain `cp` of
// urban_trends.db can miss data still sitting in the -wal file, or copy a
// half-written page if a write lands mid-copy. The backup API produces a
// single consistent snapshot regardless of what's happening concurrently.
//
// Two copies, on two schedules:
//   * LOCAL   every 6h, kept in BACKUP_DIR (next to the database, on the same persistent volume). Protects
//             against a corrupted or mistakenly changed database. It does NOT protect against losing the volume.
//   * OFF-SITE every 24h, compressed + encrypted and sent away from the machine. Protects against losing the volume.
//
// Both are driven by ONE scheduler (scheduleBackups) that remembers, in the settings table, when each last SUCCEEDED.
// A restart or redeploy therefore neither skips a backup (the old setInterval timers restarted from zero on every
// boot, so a server redeployed more often than every 6h might never have backed up) nor repeats one.
const BACKUP_DIR = path.join(path.dirname(process.env.DATABASE_PATH || './data/urban_trends.db'), 'backups');
const RETENTION_COUNT = 28; // 6h interval * 4/day = 7 days of local history

const LOCAL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const OFFSITE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000; // a failed run is retried hourly, not every tick
const ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;   // a failure that keeps happening alerts once a day, not hourly
const TICK_MS = 10 * 60 * 1000;
const BOOT_DELAY_MS = 45 * 1000;

const LOCAL_STATUS_KEY = 'last_local_backup';
const EMAIL_STATUS_KEY = 'last_backup_email';

/* ------------------------------ Status (persisted) ------------------------------ */

function readStatus(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch (_) { return null; }
}

/** Merges `patch` into the stored status, so fields such as lastSuccessAt survive a later failure. */
function recordStatus(key, patch) {
  const merged = { ...(readStatus(key) || {}), ...patch };
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, JSON.stringify(merged));
}

const getLastLocalStatus = () => readStatus(LOCAL_STATUS_KEY);
const getLastEmailStatus = () => readStatus(EMAIL_STATUS_KEY);

/* ------------------------------- Local backups ------------------------------- */

// A backup is a complete copy of the database (customer data, password hashes, encrypted credentials), so the
// folder and every file in it are owner-only. Best effort: chmod is a no-op on Windows.
function restrict(target, mode) {
  try { fs.chmodSync(target, mode); } catch (_) { /* not supported here, or not ours to change */ }
}

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  restrict(BACKUP_DIR, 0o700);
}

/** Tightens backups made before permissions were restricted. */
function hardenExistingBackups() {
  ensureBackupDir();
  for (const f of fs.readdirSync(BACKUP_DIR)) if (f.endsWith('.db')) restrict(path.join(BACKUP_DIR, f), 0o600);
}

function pruneOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ name: f, path: path.join(BACKUP_DIR, f), mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const file of files.slice(RETENTION_COUNT)) {
    fs.unlinkSync(file.path);
  }
}

async function doBackup() {
  ensureBackupDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destPath = path.join(BACKUP_DIR, `urban_trends-${timestamp}.db`);

  const start = Date.now();
  try {
    await db.backup(destPath);
    restrict(destPath, 0o600);

    // Verify BEFORE pruning: a bad file must never push a good one out of the retention window, and it must
    // never sit in the folder looking like a usable backup.
    const check = backupCrypto.quickCheck(destPath);
    if (!check.ok) {
      throw new Error(`The new backup failed its integrity check (${check.detail}) and was discarded. Earlier backups were kept.`);
    }

    pruneOldBackups();
    const result = { file: path.basename(destPath), path: destPath, sizeBytes: fs.statSync(destPath).size, durationMs: Date.now() - start };
    const at = new Date().toISOString();
    recordStatus(LOCAL_STATUS_KEY, { status: 'ok', at, file: result.file, sizeBytes: result.sizeBytes, error: null, lastSuccessAt: at, alertedAt: null });
    return result;
  } catch (err) {
    fs.rmSync(destPath, { force: true });
    recordStatus(LOCAL_STATUS_KEY, { status: 'failed', at: new Date().toISOString(), error: err.message });
    throw err;
  }
}

// One backup at a time: a manual click that lands while the scheduled one is running joins it instead of starting a
// second snapshot of the same database.
let localRun = null;

/** Runs one backup now. Returns { file, path, sizeBytes, durationMs }. */
function runBackup() {
  if (!localRun) localRun = doBackup().finally(() => { localRun = null; });
  return localRun;
}

function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ------------------------------ Off-site (email) copies ------------------------------ */
// How mail leaves the server (SMTP) is configured in Settings -> Email and handled entirely by mail.service.js.
// The RECIPIENT LIST lives in Settings (`backup_email_recipients`, comma-separated), with the old BACKUP_EMAIL_TO
// env var kept as a fallback for anyone who set that up before this existed.

function getRecipients() {
  const configured = settingsService.getAll().backup_email_recipients;
  if (configured && configured.trim()) {
    return configured.split(',').map((e) => e.trim()).filter(Boolean);
  }
  return process.env.BACKUP_EMAIL_TO ? [process.env.BACKUP_EMAIL_TO] : [];
}

function emailConfigured() {
  return mailService.isConfigured() && getRecipients().length > 0;
}

/** Whether off-site copies can be encrypted. The passphrase is env-only: it must not live in the database being backed up. */
function passphraseStatus() {
  try { backupCrypto.passphraseForOffsite(); return { passphraseSet: true, passphraseProblem: null }; } catch (err) { return { passphraseSet: false, passphraseProblem: err.message }; }
}

/**
 * Emails an existing backup file as an encrypted attachment. Throws if email isn't configured, BACKUP_PASSPHRASE is
 * missing, the encrypted copy does not decrypt again, or sending fails.
 */
async function emailBackup(backupResult) {
  if (!emailConfigured()) {
    throw new ApiError(400, 'Email backups are not configured — fill in Settings → Email (outgoing mail) and add at least one recipient under Settings → Backups.');
  }
  // The copy that leaves the server is compressed and encrypted (utils/backupCrypto.js): an emailed database holds every
  // customer's name and phone number, so it must be useless to anyone who finds it without the passphrase.
  let key;
  try { key = backupCrypto.passphraseForOffsite(); } catch (err) { throw new ApiError(400, err.message); }

  const encryptedPath = path.join(os.tmpdir(), `${backupResult.file}.${crypto.randomBytes(4).toString('hex')}.gz.enc`);
  try {
    await backupCrypto.encryptFile(backupResult.path, encryptedPath, key.value);
    // Prove the copy is usable BEFORE it leaves: it decrypts with this passphrase and the database inside is sound.
    await backupCrypto.verifyEncryptedBackup(encryptedPath, key.value);
    await mailService.sendMail({
      to: getRecipients(),
      subject: `Urban Trends POS backup (encrypted) — ${backupResult.file}`,
      text: `Automatic database backup attached. It is ENCRYPTED: open it with: node scripts/restore-backup.js <file> (with BACKUP_PASSPHRASE set to the passphrase configured on the server).\n\nFile: ${backupResult.file}\nSize: ${(backupResult.sizeBytes / 1024).toFixed(0)} KB\nGenerated: ${new Date().toISOString()}\n\nThis backup contains the full database, including user password hashes and encrypted store credentials. Saved SMS and payment-gateway credentials can only be read again with the server's ENCRYPTION_KEY, which is NOT in this backup — keep a copy of it somewhere safe and separate (a password manager), or those credentials must be re-entered after a restore.`,
      attachments: [{ filename: `${backupResult.file}.gz.enc`, path: encryptedPath }],
    });
  } finally {
    // Always remove the temp copy, including when encryption or verification failed halfway.
    fs.rm(encryptedPath, { force: true }, () => {});
  }
  logger.info('[backup] emailed an encrypted backup', { file: backupResult.file });
}

let emailRun = null;

/**
 * Backs up (kept locally like any other) and emails that same file. Returns the backup result.
 * `reuse`: a backup result that was JUST made (the scheduler does this) so one tick does not snapshot twice.
 */
function runBackupAndEmail({ reuse } = {}) {
  if (!emailRun) {
    emailRun = (async () => {
      let result = reuse || null;
      try {
        if (!result) result = await runBackup();
        await emailBackup(result);
      } catch (err) {
        recordStatus(EMAIL_STATUS_KEY, { sentAt: new Date().toISOString(), file: result ? result.file : null, status: 'failed', error: err.message });
        throw err;
      }
      const at = new Date().toISOString();
      recordStatus(EMAIL_STATUS_KEY, { sentAt: at, file: result.file, status: 'sent', error: null, lastSuccessAt: at, alertedAt: null });
      return result;
    })().finally(() => { emailRun = null; });
  }
  return emailRun;
}

/* ------------------------------- Scheduling ------------------------------- */

const ms = (iso) => (iso ? Date.parse(iso) || 0 : 0);

function lastLocalSuccessMs() {
  const s = getLastLocalStatus();
  const newestFile = listBackups()[0];
  // Backups made before status was recorded still count: go by the newest file on disk.
  return Math.max(ms(s && s.lastSuccessAt), ms(newestFile && newestFile.createdAt));
}

function lastEmailSuccessMs() {
  const s = getLastEmailStatus();
  if (!s) return 0;
  return ms(s.lastSuccessAt) || (s.status === 'sent' ? ms(s.sentAt) : 0);
}

/** Pure: is a run due? Overdue by its interval, and not inside the retry pause after a failure. */
function isDue({ lastSuccessMs, lastAttemptMs, lastStatus }, intervalMs, now = Date.now()) {
  if (lastSuccessMs && now - lastSuccessMs < intervalMs) return false;
  if (lastStatus === 'failed' && lastAttemptMs && now - lastAttemptMs < RETRY_AFTER_FAILURE_MS) return false;
  return true;
}

/** Alert on the first failure of a streak, then at most once a day while it keeps failing. */
async function alertOnce(statusKey, statusBeforeRun, now, send) {
  const recentlyAlerted = statusBeforeRun && statusBeforeRun.status === 'failed'
    && statusBeforeRun.alertedAt && now - ms(statusBeforeRun.alertedAt) < ALERT_REPEAT_MS;
  if (recentlyAlerted) return;
  await send();
  recordStatus(statusKey, { alertedAt: new Date(now).toISOString() });
}

/**
 * One scheduler pass: run whichever backups are overdue. Safe to call as often as you like; it does nothing when
 * nothing is due. Returns { local, offsite } saying what it ran.
 */
async function tick(now = Date.now()) {
  const ran = { local: false, offsite: false };
  let localResult = null;
  let localFailed = false;

  const localBefore = getLastLocalStatus();
  if (isDue({ lastSuccessMs: lastLocalSuccessMs(), lastAttemptMs: ms(localBefore && localBefore.at), lastStatus: localBefore && localBefore.status }, LOCAL_INTERVAL_MS, now)) {
    ran.local = true;
    try {
      localResult = await runBackup();
      logger.info(`[backup] wrote ${localResult.file} (${(localResult.sizeBytes / 1024).toFixed(0)} KB) in ${localResult.durationMs}ms`);
      alerting.resolveNotices('backup_failed');
    } catch (err) {
      localFailed = true;
      logger.error('[backup] failed', { error: err.message });
      await alertOnce(LOCAL_STATUS_KEY, localBefore, now, () => alerting.alertBackupFailure(err)); // a log line alone goes unnoticed; this reaches someone
    }
  }

  if (!localFailed && emailConfigured()) {
    const emailBefore = getLastEmailStatus();
    if (isDue({ lastSuccessMs: lastEmailSuccessMs(), lastAttemptMs: ms(emailBefore && emailBefore.sentAt), lastStatus: emailBefore && emailBefore.status }, OFFSITE_INTERVAL_MS, now)) {
      ran.offsite = true;
      try {
        const result = await runBackupAndEmail({ reuse: localResult });
        logger.info(`[backup] emailed ${result.file} to ${getRecipients().join(', ')}`);
        alerting.resolveNotices('backup_offsite_failed');
      } catch (err) {
        logger.error('[backup] off-site copy failed', { error: err.message });
        await alertOnce(EMAIL_STATUS_KEY, emailBefore, now, () => alerting.alertBackupEmailFailure(err));
      }
    }
  }
  return ran;
}

let tickHandle = null;
let bootHandle = null;
let ticking = false;

/**
 * Starts the backup scheduler: one check shortly after boot, then every 10 minutes. Each check runs only what is
 * actually overdue (see tick), so restarts — `npm run dev`'s --watch, or Railway redeploys — never skip a backup
 * and never spam extra ones. The first-ever backup therefore happens right after the first boot instead of 6h later.
 *
 * The off-site copy is attempted whenever email is configured, whether or not that happened before this process
 * started: the recipient list can change any time via Settings without a restart.
 */
function scheduleBackups() {
  if (tickHandle) return; // avoid double-scheduling on hot reload
  try { hardenExistingBackups(); } catch (err) { logger.warn('[backup] could not tighten backup file permissions', { error: err.message }); }
  const run = () => {
    if (ticking) return;
    ticking = true;
    tick()
      .catch((err) => logger.error('[backup] scheduler pass failed', { error: err.message }))
      .finally(() => { ticking = false; });
  };
  bootHandle = setTimeout(run, BOOT_DELAY_MS);
  tickHandle = setInterval(run, TICK_MS);
  bootHandle.unref?.();
  tickHandle.unref?.();
}

module.exports = {
  runBackup, listBackups, scheduleBackups, tick, isDue, BACKUP_DIR,
  emailConfigured, passphraseStatus, runBackupAndEmail, getLastEmailStatus, getLastLocalStatus,
};
