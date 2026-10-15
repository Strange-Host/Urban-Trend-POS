const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { encrypt, decrypt } = require('../utils/crypto');
const { toMsisdn } = require('../utils/phone');
const settingsService = require('./settings.service');
const templates = require('./smsTemplates');
const zettatel = require('../config/zettatel'); // called as zettatel.sendSms(...) so tests can spy on it

const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [1, 5, 15, 60];   // delay before attempt 2,3,4,5
const STALE_AFTER_HOURS = 24;             // a queued message this old is dropped, never delivered late
const STUCK_SENDING_MINUTES = 10;
const BATCH_SIZE = 20;

function maskPhone(msisdn) {
  const s = String(msisdn || '');
  return s.length > 6 ? `${s.slice(0, 5)}****${s.slice(-3)}` : '****';
}

// ---------------------------------------------------------------- credentials

// DB row wins; ZETTATEL_* env vars are a fallback for deployments that would
// rather keep the secret out of the database.
function getRawCredentials(storeId) {
  const settings = settingsService.getAll();
  const msgType = settings.sms_message_type === 'text' ? 'text' : 'unicode';
  const row = db.prepare('SELECT * FROM sms_credentials WHERE store_id = ? AND is_active = 1').get(storeId);
  if (row && row.user_id_enc && row.password_enc) {
    return { userId: decrypt(row.user_id_enc), password: decrypt(row.password_enc), senderId: row.sender_id || '', msgType, source: 'database' };
  }
  if (process.env.ZETTATEL_USER_ID && process.env.ZETTATEL_PASSWORD) {
    return { userId: process.env.ZETTATEL_USER_ID, password: process.env.ZETTATEL_PASSWORD, senderId: process.env.ZETTATEL_SENDER_ID || '', msgType, source: 'environment' };
  }
  return null;
}

// Never returns the secret values — only whether they're set (same convention
// as the payment gateway credentials).
function getSafeCredentials(storeId) {
  const row = db.prepare('SELECT * FROM sms_credentials WHERE store_id = ?').get(storeId);
  const raw = getRawCredentials(storeId);
  return {
    configured: Boolean(raw),
    source: raw ? raw.source : null,
    has_user_id: Boolean(row?.user_id_enc),
    has_password: Boolean(row?.password_enc),
    sender_id: row?.sender_id ?? (raw?.senderId || ''),
    is_active: row ? row.is_active : null,
  };
}

function saveCredentials({ storeId, data }) {
  const existing = db.prepare('SELECT * FROM sms_credentials WHERE store_id = ?').get(storeId);
  const userIdEnc = data.user_id !== undefined ? encrypt(data.user_id) : existing?.user_id_enc ?? null;
  const passwordEnc = data.password !== undefined ? encrypt(data.password) : existing?.password_enc ?? null;
  const senderId = data.sender_id !== undefined ? data.sender_id : existing?.sender_id ?? null;
  if (!userIdEnc || !passwordEnc) throw new ApiError(400, 'Both the Zettatel user ID and password are required the first time you save credentials.');

  if (existing) {
    db.prepare(`UPDATE sms_credentials SET user_id_enc = ?, password_enc = ?, sender_id = ?, is_active = 1, updated_at = datetime('now') WHERE id = ?`)
      .run(userIdEnc, passwordEnc, senderId, existing.id);
  } else {
    db.prepare(`INSERT INTO sms_credentials (store_id, user_id_enc, password_enc, sender_id) VALUES (?, ?, ?, ?)`)
      .run(storeId, userIdEnc, passwordEnc, senderId);
  }
  return getSafeCredentials(storeId);
}

function removeCredentials({ storeId }) {
  db.prepare('DELETE FROM sms_credentials WHERE store_id = ?').run(storeId);
  return getSafeCredentials(storeId);
}

// ------------------------------------------------------------------- enqueue

/**
 * Queues one message. Safe to call inside the caller's own transaction — it is
 * just an INSERT, so if that transaction rolls back the SMS rolls back with it.
 * `dedupeKey` makes a repeat enqueue a silent no-op (INSERT OR IGNORE against
 * the partial unique index), which is what stops a redelivered payment webhook
 * from texting the customer twice.
 */
function enqueue({ storeId, toPhone, template, body, relatedType, relatedId, dedupeKey }) {
  const msisdn = toMsisdn(toPhone);
  if (!msisdn) {
    logger.warn(`[sms] skipped ${template}: "${String(toPhone || '').slice(0, 3)}…" is not a valid Kenyan mobile number`);
    return { queued: false, reason: 'invalid_phone' };
  }
  const result = db.prepare(`
    INSERT OR IGNORE INTO sms_outbox (store_id, to_phone, template, body, related_type, related_id, dedupe_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(storeId, msisdn, template, body, relatedType || null, relatedId || null, dedupeKey || null);
  return result.changes === 1 ? { queued: true, id: result.lastInsertRowid } : { queued: false, reason: 'duplicate' };
}

function productNamesForOrder(orderId) {
  return db.prepare(`
    SELECT p.name FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = ? ORDER BY oi.id
  `).all(orderId).map((r) => r.name);
}

// The two business events. Both swallow their own errors: a messaging
// problem must never be the reason an order or a payment fails to save.
function queueOrderReceived({ order, customer }) {
  try {
    const settings = settingsService.getAll();
    if (settings.sms_enabled !== '1' || settings.sms_send_order_received !== '1') return { queued: false, reason: 'disabled' };
    const body = templates.orderReceived({
      settings, customerName: customer.name, productNames: productNamesForOrder(order.id), productCode: order.product_code,
    });
    return enqueue({
      storeId: order.store_id, toPhone: customer.phone, template: 'order_received', body,
      relatedType: 'order', relatedId: order.id, dedupeKey: `order_received:${order.id}`,
    });
  } catch (err) {
    logger.error('[sms] could not queue order_received', { orderId: order?.id, error: err.message });
    return { queued: false, reason: 'error' };
  }
}

function queuePaymentReceived({ order, customer, paymentRecordId, amountCents, amountPaidAfterCents }) {
  try {
    const settings = settingsService.getAll();
    if (settings.sms_enabled !== '1' || settings.sms_send_payment_received !== '1') return { queued: false, reason: 'disabled' };
    const body = templates.paymentReceived({
      settings, customerName: customer.name, productCode: order.product_code,
      amountCents, balanceCents: Math.max(order.total - amountPaidAfterCents, 0),
    });
    return enqueue({
      storeId: order.store_id, toPhone: customer.phone, template: 'payment_received', body,
      relatedType: 'payment_record', relatedId: paymentRecordId, dedupeKey: `payment_received:${paymentRecordId}`,
    });
  } catch (err) {
    logger.error('[sms] could not queue payment_received', { orderId: order?.id, error: err.message });
    return { queued: false, reason: 'error' };
  }
}

// -------------------------------------------------------------------- worker

let running = false;

function backoffFor(attemptsSoFar) {
  const minutes = BACKOFF_MINUTES[Math.min(attemptsSoFar - 1, BACKOFF_MINUTES.length - 1)];
  return minutes;
}

/**
 * Drains due messages. Safe to call on a timer: a guard stops overlapping
 * runs, rows are claimed (queued -> sending) before the network call, a
 * message stuck in 'sending' after a crash is recovered, and anything older
 * than 24h is expired rather than delivered late.
 */
async function processOutbox() {
  if (running) return { skipped: true };
  running = true;
  const summary = { sent: 0, retried: 0, failed: 0, expired: 0, waitingForCredentials: 0 };
  try {
    db.prepare(`
      UPDATE sms_outbox SET status = 'queued', updated_at = datetime('now')
      WHERE status = 'sending' AND updated_at < datetime('now', '-' || ? || ' minutes')
    `).run(STUCK_SENDING_MINUTES);

    summary.expired = db.prepare(`
      UPDATE sms_outbox
      SET status = 'expired', last_error = 'Not sent within ' || ? || 'h — dropped so a stale message is never delivered late.', updated_at = datetime('now')
      WHERE status = 'queued' AND created_at < datetime('now', '-' || ? || ' hours')
    `).run(STALE_AFTER_HOURS, STALE_AFTER_HOURS).changes;

    const due = db.prepare(`
      SELECT * FROM sms_outbox WHERE status = 'queued' AND next_attempt_at <= datetime('now') ORDER BY id LIMIT ?
    `).all(BATCH_SIZE);

    const credsByStore = new Map();
    for (const row of due) {
      if (!credsByStore.has(row.store_id)) credsByStore.set(row.store_id, getRawCredentials(row.store_id));
      const creds = credsByStore.get(row.store_id);
      if (!creds) { summary.waitingForCredentials += 1; continue; }

      const claimed = db.prepare(`
        UPDATE sms_outbox SET status = 'sending', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ? AND status = 'queued'
      `).run(row.id);
      if (claimed.changes !== 1) continue;
      const attempts = row.attempts + 1;

      const result = await zettatel.sendSms({ creds, to: row.to_phone, message: row.body });

      if (result.ok) {
        db.prepare(`UPDATE sms_outbox SET status = 'sent', sent_at = datetime('now'), last_error = NULL, provider_response = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(result.response || null, row.id);
        summary.sent += 1;
      } else if (attempts >= MAX_ATTEMPTS) {
        db.prepare(`UPDATE sms_outbox SET status = 'failed', last_error = ?, provider_response = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(String(result.error || 'unknown error').slice(0, 300), result.response || null, row.id);
        logger.error(`[sms] message ${row.id} (${row.template} → ${maskPhone(row.to_phone)}) failed permanently after ${attempts} attempts: ${result.error}`);
        summary.failed += 1;
      } else {
        db.prepare(`
          UPDATE sms_outbox SET status = 'queued', last_error = ?, provider_response = ?,
            next_attempt_at = datetime('now', '+' || ? || ' minutes'), updated_at = datetime('now') WHERE id = ?
        `).run(String(result.error || 'unknown error').slice(0, 300), result.response || null, backoffFor(attempts), row.id);
        summary.retried += 1;
      }
    }
    if (summary.waitingForCredentials > 0) {
      logger.warn(`[sms] ${summary.waitingForCredentials} message(s) are queued but no Zettatel credentials are configured (Settings → SMS).`);
    }
    return summary;
  } finally {
    running = false;
  }
}

// ----------------------------------------------------------------- admin ops

function listOutbox({ storeId, status, limit, offset }) {
  const where = ['store_id = ?'];
  const params = [storeId];
  if (status) { where.push('status = ?'); params.push(status); }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM sms_outbox WHERE ${where.join(' AND ')}`).get(...params).n;
  const rows = db.prepare(`
    SELECT id, to_phone, template, body, related_type, related_id, status, attempts, last_error, provider_response, created_at, sent_at
    FROM sms_outbox WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { rows, total };
}

function retry({ storeId, id }) {
  const row = db.prepare('SELECT * FROM sms_outbox WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!row) throw new ApiError(404, 'Message not found.');
  if (!['failed', 'expired'].includes(row.status)) throw new ApiError(409, `Only failed or expired messages can be retried (this one is "${row.status}").`);
  // Reset created_at too, otherwise an 'expired' row would be re-expired on the very next sweep.
  db.prepare(`UPDATE sms_outbox SET status = 'queued', attempts = 0, next_attempt_at = datetime('now'), created_at = datetime('now'), last_error = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
  return db.prepare('SELECT * FROM sms_outbox WHERE id = ?').get(id);
}

function getStatus({ storeId }) {
  const settings = settingsService.getAll();
  const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM sms_outbox WHERE store_id = ? AND created_at >= datetime('now', '-7 days') GROUP BY status`).all(storeId);
  return {
    enabled: settings.sms_enabled === '1',
    credentials: getSafeCredentials(storeId),
    last7Days: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  };
}

// Sends immediately (bypassing the queue) so the admin sees the real outcome
// — and the raw provider reply, which is how you learn Zettatel's true
// success/failure format on the first run.
async function sendTest({ storeId, to }) {
  const msisdn = toMsisdn(to);
  if (!msisdn) throw new ApiError(400, 'Enter a valid Kenyan mobile number (e.g. 0712345678).');
  const creds = getRawCredentials(storeId);
  if (!creds) throw new ApiError(400, 'No Zettatel credentials are saved yet — add them first.');

  const settings = settingsService.getAll();
  const body = `${settings.business_name || 'Urban Trends'}\nThis is a test message from your POS. SMS sending is working.`;
  const inserted = db.prepare(`INSERT INTO sms_outbox (store_id, to_phone, template, body, status, attempts) VALUES (?, ?, 'test', ?, 'sending', 1)`).run(storeId, msisdn, body);
  const result = await zettatel.sendSms({ creds, to: msisdn, message: body });
  db.prepare(`UPDATE sms_outbox SET status = ?, sent_at = CASE WHEN ? THEN datetime('now') END, last_error = ?, provider_response = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(result.ok ? 'sent' : 'failed', result.ok ? 1 : 0, result.ok ? null : String(result.error || 'unknown error').slice(0, 300), result.response || null, inserted.lastInsertRowid);
  return { ok: result.ok, error: result.error || null, providerResponse: result.response || null, to: maskPhone(msisdn) };
}

// Immediate, unqueued send for time-critical one-time codes: waiting up to 30s
// for the outbox timer would make a login code arrive after it expires. The
// message body is deliberately NOT written to sms_outbox (it contains the code).
async function sendNow({ storeId, to, message }) {
  const msisdn = toMsisdn(to);
  if (!msisdn) return { ok: false, error: 'invalid phone number' };
  const creds = getRawCredentials(storeId);
  if (!creds) return { ok: false, error: 'SMS is not configured' };
  const result = await zettatel.sendSms({ creds, to: msisdn, message });
  return { ok: result.ok, error: result.error || null };
}

module.exports = {
  sendNow, maskPhone,
  getRawCredentials, getSafeCredentials, saveCredentials, removeCredentials,
  enqueue, queueOrderReceived, queuePaymentReceived,
  processOutbox, listOutbox, retry, getStatus, sendTest,
  MAX_ATTEMPTS,
};
