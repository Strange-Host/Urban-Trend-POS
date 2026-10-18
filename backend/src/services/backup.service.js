const fs = require('fs');
const os = require('os');
const path = require('path');
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
const BACKUP_DIR = path.join(path.dirname(process.env.DATABASE_PATH || './data/urban_trends.db'), 'backups');
const RETENTION_COUNT = 28; // 6h interval * 4/day = 7 days of local history

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
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

/** Runs one backup now. Returns { file, path, sizeBytes, durationMs }. */
async function runBackup() {
  ensureBackupDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destPath = path.join(BACKUP_DIR, `urban_trends-${timestamp}.db`);

  const start = Date.now();
  await db.backup(destPath);
  const durationMs = Date.now() - start;

  pruneOldBackups();

  return { file: path.basename(destPath), path: destPath, sizeBytes: fs.statSync(destPath).size, durationMs };
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

/* ------------------------------ Email backups ------------------------------ */
// A second, independent copy of the backup story: local backups (above)
// protect against a corrupted database file on THIS machine — they're
// useless if the machine itself is lost, stolen, or its disk dies. Emailing
// a copy off-machine on a slower cadence (24h, vs. 6h locally) gives cheap
// off-site recovery without standing up real cloud backup infrastructure.
// How mail leaves the server (SMTP, or Resend over HTTPS) is configured in
// Settings -> Email and handled entirely by mail.service.js. The RECIPIENT
// LIST lives in Settings (`backup_email_recipients`, comma-separated), with
// the old BACKUP_EMAIL_TO env var kept as a fallback for anyone who set that
// up before this existed.

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

const LAST_EMAIL_SETTINGS_KEY = 'last_backup_email';

function recordEmailStatus(status) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(LAST_EMAIL_SETTINGS_KEY, JSON.stringify(status));
}

function getLastEmailStatus() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(LAST_EMAIL_SETTINGS_KEY);
  return row ? JSON.parse(row.value) : null;
}

/** Emails an existing backup file as an attachment (SMTP or Resend, whichever Settings -> Email selects). Throws if email isn't configured or sending fails. */
async function emailBackup(backupResult) {
  if (!emailConfigured()) {
    throw new ApiError(400, 'Email backups are not configured — fill in Settings → Email (outgoing mail) and add at least one recipient under Settings → Backups.');
  }
  // The copy that leaves the server is compressed and encrypted (utils/backupCrypto.js): an emailed database holds every
  // customer's name and phone number, so it must be useless to anyone who finds it without the passphrase.
  const { value: passphrase, source } = backupCrypto.passphraseFromEnv();
  const encryptedPath = path.join(os.tmpdir(), `${backupResult.file}.gz.enc`);
  await backupCrypto.encryptFile(backupResult.path, encryptedPath, passphrase);
  try {
  await mailService.sendMail({
    to: getRecipients(),
    subject: `Urban Trends POS backup (encrypted) — ${backupResult.file}`,
    text: `Automatic database backup attached. It is ENCRYPTED: open it with: node scripts/restore-backup.js <file> (needs your BACKUP_PASSPHRASE, or the server's ENCRYPTION_KEY if no passphrase was set).\n\nFile: ${backupResult.file}\nSize: ${(backupResult.sizeBytes / 1024).toFixed(0)} KB\nGenerated: ${new Date().toISOString()}\n\nThis backup contains the full database, including encrypted store credentials and user password hashes — keep this email as secure as you would the server itself.`,
    attachments: [{ filename: `${backupResult.file}.gz.enc`, path: encryptedPath }],
  });
  } finally {
    fs.rm(encryptedPath, { force: true }, () => {});
  }
  logger.info('[backup] emailed an encrypted backup', { file: backupResult.file, keySource: source });
}

/** Runs a fresh backup (kept locally like any other) and emails that same file. Returns the backup result. */
async function runBackupAndEmail() {
  const result = await runBackup();
  try {
    await emailBackup(result);
    recordEmailStatus({ sentAt: new Date().toISOString(), file: result.file, status: 'sent' });
  } catch (err) {
    recordEmailStatus({ sentAt: new Date().toISOString(), file: result.file, status: 'failed', error: err.message });
    throw err;
  }
  return result;
}

/* ------------------------------- Scheduling ------------------------------- */

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
let localIntervalHandle = null;
let emailIntervalHandle = null;

/**
 * Schedules automatic local backups every 6 hours. Does NOT run one
 * immediately — with `npm run dev`'s --watch restarting the server on
 * every file save, an immediate backup on every boot would spam the
 * backups folder during development. The first automatic backup happens
 * 6h after the process starts; use POST /api/backups/run for an on-demand
 * one, e.g. right after a fresh deploy.
 */
function scheduleBackups() {
  if (localIntervalHandle) return; // avoid double-scheduling on hot reload
  localIntervalHandle = setInterval(() => {
    runBackup()
      .then((result) => logger.info(`[backup] wrote ${result.file} (${(result.sizeBytes / 1024).toFixed(0)} KB) in ${result.durationMs}ms`))
      .catch((err) => {
        logger.error('[backup] failed', { error: err.message });
        alerting.alertBackupFailure(err); // 2.4 — a log line alone goes unnoticed; this actually reaches someone
      });
  }, SIX_HOURS_MS);
  localIntervalHandle.unref?.();
}

/**
 * Schedules the email backup on its own independent 24h cadence — separate
 * from the 6h local schedule above, per the requirement that emailed copies
 * go out once a day rather than every 6h (an inbox filling up with 4
 * multi-MB attachments a day gets old fast). Same "don't run immediately
 * on boot" reasoning as scheduleBackups().
 *
 * Always schedules the interval, even if nothing's configured yet — the
 * recipient list can change any time via Settings without a server
 * restart, so a one-time "not configured" check at boot would otherwise
 * permanently disable this until the process restarts. Each run just
 * checks and logs for itself; see emailConfigured()/emailBackup().
 */
function scheduleEmailBackups() {
  if (emailIntervalHandle) return;
  if (!emailConfigured()) {
    logger.info('[backup] email backups not yet configured — set up Settings → Email (SMTP or Resend) and add a recipient under Settings → Backups');
  }
  emailIntervalHandle = setInterval(() => {
    if (!emailConfigured()) return; // still not configured — silently skip this cycle, not an error
    runBackupAndEmail()
      .then((result) => logger.info(`[backup] emailed ${result.file} to ${getRecipients().join(', ')}`))
      .catch((err) => {
        logger.error('[backup] email failed', { error: err.message });
        alerting.alertBackupEmailFailure(err); // 2.4 — see scheduleBackups() above for the same reasoning
      });
  }, TWENTY_FOUR_HOURS_MS);
  emailIntervalHandle.unref?.();
}

module.exports = {
  runBackup, listBackups, scheduleBackups, BACKUP_DIR,
  emailConfigured, runBackupAndEmail, getLastEmailStatus, scheduleEmailBackups,
};
