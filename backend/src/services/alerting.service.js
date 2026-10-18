const mailService = require('./mail.service');
const notifications = require('./notifications.service');
const db = require('../config/db');
const logger = require('../utils/logger');
const settingsService = require('./settings.service');

// 2.4 — before this, a failed backup or a drifted inventory row only ever
// produced a log line: something nobody looks at unless they already
// suspect a problem. This deliberately duplicates backup.service.js's
// small amount of recipient setup (same backup_email_recipients setting)
// rather than importing it directly —
// backup.service.js is going to need to call INTO this module (to alert on
// its own failures), so importing back the other way would make the two
// files circularly require each other. A dozen duplicated lines is a much
// smaller cost than a fragile circular dependency.
//
// Every alert now has TWO channels: an in-app notice for each admin (the bell in the header - works even when
// email is not set up, or is blocked by the host), and an email to the configured recipients when email is set up.
// The in-app notice is de-duplicated (one per admin until the problem is resolved, see resolveNotices), so a
// failure that keeps repeating does not pile up unread rows.
//
// sendAlert deliberately does NOT throw — alerting is a courtesy on top of
// the real error, not a new failure mode of its own. A misconfigured mail
// server should never turn "the actual backup failed" into an unhandled
// exception on top of it; the original error is still logged either way
// (callers log it themselves before/after calling this).

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

/** One in-app notice per active admin (an admin without a store is filed under the first store). Never throws. */
function notifyAdmins({ type, title, body, dedupeKey, entityType = null }) {
  try {
    const admins = db.prepare(`
      SELECT id, COALESCE(store_id, (SELECT MIN(id) FROM stores)) AS store_id FROM users
      WHERE role = 'admin' AND is_active = 1
    `).all().filter((a) => a.store_id);
    const byStore = new Map();
    for (const a of admins) byStore.set(a.store_id, [...(byStore.get(a.store_id) || []), a.id]);
    let created = 0;
    for (const [storeId, userIds] of byStore) {
      created += notifications.notify({
        storeId, userIds, type, title, body: body ? String(body).slice(0, 500) : null,
        severity: 'urgent', entityType, dedupeKey,
      });
    }
    return created;
  } catch (err) {
    logger.error('[alert] could not create the in-app notice', { error: err.message, type });
    return 0;
  }
}

/** Releases a notice's de-duplication key once its problem is fixed, so the NEXT failure notifies again. */
function resolveNotices(type) {
  try {
    return db.prepare('UPDATE notifications SET dedupe_key = NULL WHERE type = ? AND dedupe_key IS NOT NULL').run(type).changes;
  } catch (err) {
    logger.error('[alert] could not resolve notices', { error: err.message, type });
    return 0;
  }
}

/** Returns whether the EMAIL went out; the in-app notice is created either way. */
async function sendAlert({ subject, message, notice }) {
  if (notice) notifyAdmins({ title: subject, body: notice.body || message, ...notice });
  if (!emailConfigured()) {
    logger.warn(`[alert] not sent (email not configured) — ${subject}`);
    return false;
  }
  try {
    await mailService.sendMail({
      to: getRecipients(),
      subject: `[Urban Trends POS alert] ${subject}`,
      text: `${message}\n\nSent: ${new Date().toISOString()}`,
    });
    return true;
  } catch (err) {
    logger.error('[alert] failed to send alert email', { error: err.message, subject });
    return false;
  }
}

function alertBackupFailure(err) {
  return sendAlert({
    notice: { type: 'backup_failed', entityType: 'backup', dedupeKey: 'backup:local', body: err.message },
    subject: 'Automatic backup failed',
    message: `The scheduled database backup failed with:\n\n${err.message}\n\nLocal backups (last known-good ones) are unaffected — this only means a NEW backup didn't get made this cycle. If this keeps happening, check disk space and file permissions on the backup directory.`,
  });
}

function alertBackupEmailFailure(err) {
  return sendAlert({
    notice: { type: 'backup_offsite_failed', entityType: 'backup', dedupeKey: 'backup:offsite', body: err.message },
    subject: 'Off-site backup copy failed',
    message: `The local backup itself succeeded, but sending a copy off-machine failed with:\n\n${err.message}\n\nA missing BACKUP_PASSPHRASE, a wrong or expired SMTP app password, or a host that blocks SMTP (Railway Free/Trial/Hobby) are the most common causes. Open Settings → Backups to see the last result, and Settings → Email to send a test email.`,
  });
}

function alertInventoryDrift(driftRows) {
  const preview = driftRows.slice(0, 10)
    .map((r) => `  ${r.product_name} (${r.sku}), store ${r.store_id}: cached=${r.cached_quantity}, ledger=${r.ledger_quantity} (drift ${r.drift > 0 ? '+' : ''}${r.drift})`)
    .join('\n');
  return sendAlert({
    notice: { type: 'inventory_drift', dedupeKey: 'inventory_drift', body: `${driftRows.length} inventory row(s) no longer match the movement ledger. Nothing was changed automatically; review via GET /api/inventory/reconcile.` },
    subject: `Inventory drift detected (${driftRows.length} row${driftRows.length === 1 ? '' : 's'})`,
    message: `${driftRows.length} inventory row(s) no longer match the movement ledger:\n\n${preview}${driftRows.length > 10 ? `\n  …and ${driftRows.length - 10} more` : ''}\n\nThis is detect-only — nothing has been changed automatically (see reconciliation.service.js for why). Review via GET /api/inventory/reconcile, and run POST /api/inventory/reconcile once you're confident the ledger is right, to sync inventory.quantity to match it.`,
  });
}

module.exports = { sendAlert, alertBackupFailure, alertBackupEmailFailure, alertInventoryDrift, resolveNotices };
