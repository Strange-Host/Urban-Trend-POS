const mailService = require('./mail.service');
const logger = require('../utils/logger');
const settingsService = require('./settings.service');

// 2.4 — before this, a failed backup or a drifted inventory row only ever
// produced a log line: something nobody looks at unless they already
// suspect a problem. This deliberately duplicates backup.service.js's
// small amount of SMTP setup (same SMTP_* env vars, same
// backup_email_recipients setting) rather than importing it directly —
// backup.service.js is going to need to call INTO this module (to alert on
// its own failures), so importing back the other way would make the two
// files circularly require each other. A dozen duplicated lines is a much
// smaller cost than a fragile circular dependency.
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

const getTransport = () => mailService.getTransport();

async function sendAlert({ subject, message }) {
  if (!emailConfigured()) {
    logger.warn(`[alert] not sent (email not configured) — ${subject}`);
    return false;
  }
  try {
    const transport = getTransport();
    await transport.sendMail({
      from: mailService.fromAddress(),
      to: getRecipients().join(', '),
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
    subject: 'Automatic backup failed',
    message: `The scheduled database backup failed with:\n\n${err.message}\n\nLocal backups (last known-good ones) are unaffected — this only means a NEW backup didn't get made this cycle. If this keeps happening, check disk space and file permissions on the backup directory.`,
  });
}

function alertBackupEmailFailure(err) {
  return sendAlert({
    subject: 'Backup email failed to send',
    message: `The local backup itself succeeded, but emailing a copy off-machine failed with:\n\n${err.message}\n\nCheck the SMTP_* settings in .env — a bad SMTP password or an expired app-password is the most common cause.`,
  });
}

function alertInventoryDrift(driftRows) {
  const preview = driftRows.slice(0, 10)
    .map((r) => `  ${r.product_name} (${r.sku}), store ${r.store_id}: cached=${r.cached_quantity}, ledger=${r.ledger_quantity} (drift ${r.drift > 0 ? '+' : ''}${r.drift})`)
    .join('\n');
  return sendAlert({
    subject: `Inventory drift detected (${driftRows.length} row${driftRows.length === 1 ? '' : 's'})`,
    message: `${driftRows.length} inventory row(s) no longer match the movement ledger:\n\n${preview}${driftRows.length > 10 ? `\n  …and ${driftRows.length - 10} more` : ''}\n\nThis is detect-only — nothing has been changed automatically (see reconciliation.service.js for why). Review via GET /api/inventory/reconcile, and run POST /api/inventory/reconcile once you're confident the ledger is right, to sync inventory.quantity to match it.`,
  });
}

module.exports = { sendAlert, alertBackupFailure, alertBackupEmailFailure, alertInventoryDrift };
