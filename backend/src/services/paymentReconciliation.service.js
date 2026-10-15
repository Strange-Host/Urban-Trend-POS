const crypto = require('crypto');
const { todaySql } = require('../utils/storeTime');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const ordersService = require('./orders.service');
const notificationsService = require('./notifications.service');

const SOURCES = ['kcb', 'mpesa', 'manual'];
const METHODS = ['mobile_money', 'bank_transfer', 'cash'];
// Statuses an order can actually receive a payment against — mirrors the
// precondition orders.service.recordPayment already enforces, checked here
// too so an auto-match attempt against e.g. a cancelled order fails over
// to "unmatched" instead of throwing out of ingestNotification entirely.
const PAYABLE_ORDER_STATUSES = ['dispatched_unpaid', 'dispatched_partial'];

// The product code is usually the entire M-Pesa/KCB "account number" field
// verbatim, but this tolerates it showing up inside a longer narrative
// (e.g. a bank transfer description) too.
function extractProductCode(text) {
  if (!text) return null;
  const match = String(text).toUpperCase().match(/UT\d{6}/);
  return match ? match[0] : null;
}

// A webhook notification has no logged-in staff member behind it — but
// payment_records.recorded_by_staff_id is (correctly) NOT NULL everywhere
// else in the app, so an auto-matched payment needs SOME user row to
// attribute to. This lazily creates one system account per store the
// first time it's needed: is_active = 0 so authenticate() will never let
// anything actually log in as it (see middleware/auth.js), and its
// password hash is random bytes rather than a real bcrypt hash, so even a
// leaked row can't be used to log in either.
function getOrCreateSystemUser(storeId) {
  const email = `system+store${storeId}@urbantrends.internal`;
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) return existing;

  const unusablePasswordHash = crypto.randomBytes(32).toString('hex');
  const result = db.prepare(`
    INSERT INTO users (store_id, name, email, password_hash, role, is_active)
    VALUES (?, 'System (automated payment reconciliation)', ?, ?, 'admin', 0)
  `).run(storeId, email, unusablePasswordHash);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
}

// Outgoing money (§ "money spent") has no order to match against — a
// supplier payment, courier payout, or till withdrawal isn't tied to a
// customer order at all. Lazily creates one shared category the same way
// getOrCreateSystemUser lazily creates its system account, so this never
// fails just because nobody's set up an expense category for it yet;
// staff can always recategorize the resulting expense afterward.
function getOrCreateBankTransactionsCategory() {
  const name = 'Bank & Mobile Money (Auto-Mirrored)';
  const existing = db.prepare('SELECT * FROM expense_categories WHERE name = ?').get(name);
  if (existing) return existing;
  const result = db.prepare('INSERT INTO expense_categories (name) VALUES (?)').run(name);
  return db.prepare('SELECT * FROM expense_categories WHERE id = ?').get(result.lastInsertRowid);
}

// The main entry point — called by the KCB/M-Pesa webhook routes (and
// reusable directly for a manual "paste in a transaction" flow later).
// Always succeeds and returns a notification row: a payment that can't be
// matched is recorded as 'unmatched' for follow-up, never dropped or
// thrown away, because "flag unmatched payments for follow-up" (§2) means
// keeping every one of them somewhere reviewable.
function ingestNotification({ storeId, source, method, amount, externalReference, narrative, payerName, rawPayload, direction }) {
  if (!SOURCES.includes(source)) throw new ApiError(400, `source must be one of ${SOURCES.join(', ')}.`);
  if (!METHODS.includes(method)) throw new ApiError(400, `method must be one of ${METHODS.join(', ')}.`);
  if (!amount || amount <= 0) throw new ApiError(400, 'amount must be a positive integer (cents).');
  const finalDirection = direction || 'incoming';

  // Idempotency: webhooks redeliver. The same (source, external_reference)
  // arriving twice returns the already-recorded result rather than
  // double-applying the payment — this is exactly what
  // idx_payment_notifications_dedup exists to make safe even under a race.
  if (externalReference) {
    const existing = db.prepare(`
      SELECT * FROM payment_notifications WHERE source = ? AND external_reference = ?
    `).get(source, externalReference);
    if (existing) return existing;
  }

  if (finalDirection === 'outgoing') return ingestOutgoing({ storeId, source, method, amount, externalReference, narrative, payerName, rawPayload });

  const matchedCode = extractProductCode(narrative) || extractProductCode(externalReference);

  const txn = db.transaction(() => {
    let order = null;
    if (matchedCode) {
      order = ordersService.findByProductCode({ storeId, productCode: matchedCode });
    }

    let status = 'unmatched';
    let orderId = null;
    let resolvedBy = null;
    let resolvedAt = null;

    if (order && PAYABLE_ORDER_STATUSES.includes(order.status)) {
      const systemUser = getOrCreateSystemUser(storeId);
      ordersService.recordPayment({
        orderId: order.id, storeId, staffId: systemUser.id, method, amount, reference: externalReference,
      });
      status = 'matched';
      orderId = order.id;
      resolvedBy = systemUser.id;
      resolvedAt = new Date().toISOString().replace('T', ' ').slice(0, 19);
    }
    // matchedCode found but the order isn't in a payable state (already
    // paid, still awaiting dispatch, returned, cancelled) — deliberately
    // left 'unmatched' with order_id set to NULL here (not the found
    // order) so it surfaces in the review queue rather than looking
    // auto-resolved; a human decides what a payment against a cancelled
    // order should do, matchedCode is preserved below for their context.

    let insertResult;
    try {
      insertResult = db.prepare(`
        INSERT INTO payment_notifications (
          store_id, source, method, amount, direction, external_reference, matched_code, payer_name,
          order_id, status, raw_payload, resolved_by, resolved_at
        ) VALUES (?, ?, ?, ?, 'incoming', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        storeId, source, method, amount, externalReference || null, matchedCode || null, payerName || null,
        orderId, status, rawPayload ? JSON.stringify(rawPayload) : null, resolvedBy, resolvedAt
      );
    } catch (err) {
      // A concurrent delivery of the same webhook could race past the
      // idempotency check above and hit the unique index instead —
      // treat that exactly like the idempotency check finding it first.
      if (err.code && err.code.startsWith('SQLITE_CONSTRAINT') && externalReference) {
        return db.prepare(`SELECT * FROM payment_notifications WHERE source = ? AND external_reference = ?`).get(source, externalReference);
      }
      throw err;
    }

    const saved = db.prepare('SELECT * FROM payment_notifications WHERE id = ?').get(insertResult.lastInsertRowid);
    if (saved.status === 'unmatched') notificationsService.notifyUnmatchedPayment({ notification: saved });
    return saved;
  });

  return txn();
}

// Outgoing (§ "money spent... mirrored into the application"): no order to
// match, so this always mirrors straight into `expenses` — visible in
// profit-summary the same as any manually-entered expense — and marks
// itself 'matched' (meaning "successfully recorded", not "matched to an
// order"; there's no order for an outgoing payment to match).
function ingestOutgoing({ storeId, source, method, amount, externalReference, narrative, payerName, rawPayload }) {
  const txn = db.transaction(() => {
    const systemUser = getOrCreateSystemUser(storeId);
    const category = getOrCreateBankTransactionsCategory();
    const today = db.prepare(`SELECT ${todaySql()} AS d`).get().d;

    const expenseResult = db.prepare(`
      INSERT INTO expenses (store_id, category_id, amount, description, expense_date, recorded_by_staff_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      storeId, category.id, amount,
      `Auto-mirrored ${source} payment${payerName ? ` to ${payerName}` : ''}${narrative ? ` — ${narrative}` : ''}`,
      today, systemUser.id
    );

    let insertResult;
    try {
      insertResult = db.prepare(`
        INSERT INTO payment_notifications (
          store_id, source, method, amount, direction, external_reference, payer_name,
          expense_id, status, raw_payload, resolved_by, resolved_at
        ) VALUES (?, ?, ?, ?, 'outgoing', ?, ?, ?, 'matched', ?, ?, datetime('now'))
      `).run(
        storeId, source, method, amount, externalReference || null, payerName || null,
        expenseResult.lastInsertRowid, rawPayload ? JSON.stringify(rawPayload) : null, systemUser.id
      );
    } catch (err) {
      if (err.code && err.code.startsWith('SQLITE_CONSTRAINT') && externalReference) {
        return db.prepare(`SELECT * FROM payment_notifications WHERE source = ? AND external_reference = ?`).get(source, externalReference);
      }
      throw err;
    }

    return db.prepare('SELECT * FROM payment_notifications WHERE id = ?').get(insertResult.lastInsertRowid);
  });
  return txn();
}

function listUnmatched({ storeId, limit, offset }) {
  const rows = db.prepare(`
    SELECT * FROM payment_notifications WHERE store_id = ? AND status = 'unmatched'
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(storeId, limit, offset);
  const agg = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount), 0) a FROM payment_notifications WHERE store_id = ? AND status = 'unmatched'`).get(storeId);
  // `unallocated` covers ALL unmatched payments, not just the page shown (the page used to total its own 25 rows)
  return { rows, total: agg.c, summary: { unallocated: agg.a } };
}

// Handles what the source docs call out explicitly: two customers with
// similar names/amounts, or a spouse paying on someone else's behalf — a
// human matches the notification to the right order by hand, using
// whatever context (payer name, amount, timing) the automatic match
// couldn't use safely.
function manualMatch({ notificationId, storeId, orderId, staffId, method, reference }) {
  const notification = db.prepare('SELECT * FROM payment_notifications WHERE id = ? AND store_id = ?').get(notificationId, storeId);
  if (!notification) throw new ApiError(404, 'Payment notification not found.');
  if (notification.status !== 'unmatched') throw new ApiError(409, `This notification is already "${notification.status}".`);

  const txn = db.transaction(() => {
    ordersService.recordPayment({
      orderId, storeId, staffId,
      method: method || notification.method,
      amount: notification.amount,
      reference: reference || notification.external_reference,
    });

    db.prepare(`
      UPDATE payment_notifications SET status = 'matched', order_id = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?
    `).run(orderId, staffId, notificationId);

    return db.prepare('SELECT * FROM payment_notifications WHERE id = ?').get(notificationId);
  });
  return txn();
}

function ignore({ notificationId, storeId, staffId }) {
  const notification = db.prepare('SELECT * FROM payment_notifications WHERE id = ? AND store_id = ?').get(notificationId, storeId);
  if (!notification) throw new ApiError(404, 'Payment notification not found.');
  if (notification.status !== 'unmatched') throw new ApiError(409, `This notification is already "${notification.status}".`);

  db.prepare(`
    UPDATE payment_notifications SET status = 'ignored', resolved_by = ?, resolved_at = datetime('now') WHERE id = ?
  `).run(staffId, notificationId);
  return db.prepare('SELECT * FROM payment_notifications WHERE id = ?').get(notificationId);
}

module.exports = { extractProductCode, ingestNotification, listUnmatched, manualMatch, ignore, getOrCreateSystemUser };
