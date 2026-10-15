const db = require('../config/db');
const { todaySql } = require('../utils/storeTime');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

// In-app notifications. One row per RECIPIENT, so a notice for "all
// managers" fans out to one row each; read-state and ownership are then a
// plain user_id check — a user can only ever list or mark their own rows.
//
// Delivery is by polling (GET /api/notifications/unread-count on a timer in
// the UI), deliberately NOT SSE: the older system's SSE channel never worked
// in its own frontend (EventSource cannot send an Authorization header, and
// the page read the wrong token key), and polling a tiny indexed count every
// 30s is plenty for a one-shop back office.

const SEVERITIES = ['info', 'warning', 'urgent'];

function userIdsForRoles(storeId, roles) {
  if (!roles || roles.length === 0) return [];
  const placeholders = roles.map(() => '?').join(',');
  // is_active = 1 also excludes the lazily-created "system" account.
  return db.prepare(`SELECT id FROM users WHERE store_id = ? AND is_active = 1 AND role IN (${placeholders})`)
    .all(storeId, ...roles).map((r) => r.id);
}

/**
 * Creates one notification per distinct recipient (explicit userIds ∪ every
 * active user holding one of `roles`). A repeat with the same dedupeKey is a
 * silent no-op per user, so sweeps can run every few minutes without
 * re-notifying. Never throws — a notification problem must not break the
 * business operation that triggered it.
 * Returns the number of rows actually created.
 */
function notify({ storeId, userIds = [], roles = [], type, title, body = null, severity = 'info', entityType = null, entityId = null, dedupeKey = null }) {
  try {
    if (!SEVERITIES.includes(severity)) severity = 'info';
    const recipients = [...new Set([...userIds.filter(Boolean), ...userIdsForRoles(storeId, roles)])];
    const insert = db.prepare(`
      INSERT OR IGNORE INTO notifications (store_id, user_id, type, title, body, severity, entity_type, entity_id, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let created = 0;
    for (const userId of recipients) {
      created += insert.run(storeId, userId, type, title, body, severity, entityType, entityId, dedupeKey).changes;
    }
    return created;
  } catch (err) {
    logger.error('[notifications] could not create notification', { type, error: err.message });
    return 0;
  }
}

function listForUser({ userId, unreadOnly, limit, offset }) {
  const where = ['user_id = ?'];
  const params = [userId];
  if (unreadOnly) where.push('read_at IS NULL');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${where.join(' AND ')}`).get(...params).n;
  const rows = db.prepare(`
    SELECT id, type, title, body, severity, entity_type, entity_id, read_at, created_at
    FROM notifications WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  return { rows, total };
}

function unreadCount(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId).n;
}

// Ownership-scoped: someone else's notification id behaves exactly like a
// nonexistent one (404), so ids can't be probed.
function markRead({ userId, id }) {
  const row = db.prepare('SELECT id FROM notifications WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) throw new ApiError(404, 'Notification not found.');
  db.prepare(`UPDATE notifications SET read_at = COALESCE(read_at, datetime('now')) WHERE id = ? AND user_id = ?`).run(id, userId);
  return { id, read: true };
}

function markAllRead(userId) {
  const result = db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`).run(userId);
  return { updated: result.changes };
}

// ---------------------------------------------------------------- event hooks

function notifyLeadAssigned({ lead, assignedStaffId, actorId }) {
  if (!assignedStaffId || assignedStaffId === actorId) return 0; // assigning to yourself isn't news
  return notify({
    storeId: lead.store_id, userIds: [assignedStaffId], type: 'lead_assigned',
    title: `New lead assigned: ${lead.name}`, body: `${lead.name} · ${lead.phone}`,
    entityType: 'lead', entityId: lead.id, dedupeKey: `lead_assigned:${lead.id}:${assignedStaffId}`,
  });
}

function notifyDamagedReturn({ order }) {
  return notify({
    storeId: order.store_id, roles: ['admin'], type: 'damaged_return', severity: 'urgent',
    title: `Damaged return needs an owner decision (${order.product_code || `order #${order.id}`})`,
    body: 'Stock is blocked from resale until you decide: write off, repair, or return to supplier.',
    entityType: 'order', entityId: order.id, dedupeKey: `damaged_return:${order.id}`,
  });
}

function notifyUnmatchedPayment({ notification }) {
  const kes = (notification.amount / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return notify({
    storeId: notification.store_id, roles: ['admin', 'manager'], type: 'unmatched_payment', severity: 'warning',
    title: `Unmatched ${String(notification.source).toUpperCase()} payment: KES ${kes}`,
    body: [notification.payer_name, notification.external_reference && `ref ${notification.external_reference}`].filter(Boolean).join(' · ') || null,
    entityType: 'payment_notification', entityId: notification.id, dedupeKey: `unmatched_payment:${notification.id}`,
  });
}

// ---------------------------------------------------------------------- sweeps

// Leads whose rescheduled follow-up date has arrived. follow_up_date is a plain
// date, so a lead is "due" for the whole of that day and every day after until
// someone acts on it (status leaves 'rescheduled'). One notice per
// (lead, follow-up date) — if the date is pushed back, the new date notifies afresh.
function sweepLeadFollowUps() {
  const due = db.prepare(`
    SELECT id, store_id, name, phone, assigned_staff_id, follow_up_date FROM leads
    WHERE deleted_at IS NULL AND status = 'rescheduled' AND follow_up_date IS NOT NULL
      AND follow_up_date <= ${todaySql()}
  `).all();
  let created = 0;
  for (const lead of due) {
    created += notify({
      storeId: lead.store_id,
      userIds: lead.assigned_staff_id ? [lead.assigned_staff_id] : [],
      roles: ['admin', 'manager'], // the older system told admins only — the person who owns the lead must hear it too
      type: 'lead_follow_up_due', severity: 'warning',
      title: `Follow-up due: ${lead.name}`, body: `${lead.phone} · follow-up was set for ${lead.follow_up_date}`,
      entityType: 'lead', entityId: lead.id, dedupeKey: `lead_follow_up:${lead.id}:${lead.follow_up_date}`,
    });
  }
  return created;
}

// Products at/below their reorder level. A notice is raised once per low
// episode: it stays de-duplicated while the product remains low (even after
// being read), and its dedupe key is released the moment stock recovers, so
// the NEXT time it runs low it notifies again.
function sweepLowStock() {
  const low = db.prepare(`
    SELECT i.product_id, i.store_id, i.quantity, i.reorder_level, p.name
    FROM inventory i JOIN products p ON p.id = i.product_id
    WHERE p.is_active = 1 AND i.quantity <= i.reorder_level
  `).all();

  let created = 0;
  for (const row of low) {
    created += notify({
      storeId: row.store_id, roles: ['admin', 'manager'], type: 'low_stock',
      severity: row.quantity <= 0 ? 'urgent' : 'warning',
      title: row.quantity <= 0 ? `Out of stock: ${row.name}` : `Low stock: ${row.name}`,
      body: `${row.quantity} left (reorder level ${row.reorder_level})`,
      entityType: 'product', entityId: row.product_id, dedupeKey: `low_stock:${row.product_id}`,
    });
  }

  db.prepare(`
    UPDATE notifications SET dedupe_key = NULL
    WHERE type = 'low_stock' AND dedupe_key IS NOT NULL
      AND entity_id NOT IN (SELECT product_id FROM inventory WHERE quantity <= reorder_level)
  `).run();
  return created;
}

// Housekeeping so the table can't grow forever: read notices after 30 days,
// anything after 90.
function pruneOld() {
  return db.prepare(`
    DELETE FROM notifications
    WHERE (read_at IS NOT NULL AND created_at < datetime('now', '-30 days')) OR created_at < datetime('now', '-90 days')
  `).run().changes;
}

function runSweeps() {
  const result = { followUps: 0, lowStock: 0, pruned: 0 };
  result.followUps = sweepLeadFollowUps();
  result.lowStock = sweepLowStock();
  result.pruned = pruneOld();
  return result;
}

module.exports = {
  notify, listForUser, unreadCount, markRead, markAllRead,
  notifyLeadAssigned, notifyDamagedReturn, notifyUnmatchedPayment,
  sweepLeadFollowUps, sweepLowStock, pruneOld, runSweeps,
};
