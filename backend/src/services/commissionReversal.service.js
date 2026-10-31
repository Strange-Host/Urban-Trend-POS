const db = require('../config/db');
const { offsetMinutes } = require('../utils/storeTime');
const { logStaffAction } = require('../utils/auditLog');
const notificationsService = require('./notifications.service');

// Taking commission back when the sale it was paid on falls through.
//
// Commission is paid only on secure money, and an approved payroll run is locked for good (Rule 9) - so when an order
// that already earned commission is later refunded, returned or cancelled, the old run cannot be edited. Instead a
// reversal is posted as a deduction (a 'loss_deduction' payroll adjustment linked to the order) dated the day it
// happened, so it comes off the pay of whichever cycle that day falls in. The unique index on
// payroll_adjustments.reverses_order_id means an order is taken back at most once, however many paths notice it.
//
// An order that had NOT yet been commissioned needs none of this: it simply stops counting as secured, so it drops
// out of the next calculation (see commission.service.js securedOrders).

const dayAfter = (ymd) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);

/** What was paid on this order: the amount recorded at approval, or - for runs approved before pay types - units x the run's rate. */
function commissionPaidFor(orderId) {
  const row = db.prepare(`
    SELECT co.order_id, co.staff_id, co.units, co.commission, co.run_id, pi.rate
      FROM commissioned_orders co
      LEFT JOIN payroll_items pi ON pi.run_id = co.run_id AND pi.staff_id = co.staff_id
     WHERE co.order_id = ?
  `).get(orderId);
  if (!row) return null;
  return { staffId: row.staff_id, runId: row.run_id, amount: row.commission ?? row.units * (row.rate ?? 0) };
}

/**
 * When a reversal must be dated so it lands in a pay period that has not been locked. Normally that is now. If a
 * locked run already covers today (someone closed the month early), the reversal is dated the day after the latest
 * locked period ends - otherwise no run would ever pick it up and the money would never come back.
 */
function reversalTimestamp(storeId) {
  const lockedEnd = db.prepare(`SELECT MAX(period_end) AS d FROM payroll_runs WHERE store_id = ? AND status <> 'draft'`).get(storeId).d;
  const today = db.prepare(`SELECT date('now', '+${offsetMinutes()} minutes') AS d`).get().d;
  if (!lockedEnd || lockedEnd < today) return null; // null = just use now()
  // Midday on that shop day, expressed in UTC like every other timestamp.
  return db.prepare(`SELECT datetime(?, '-${offsetMinutes()} minutes') AS t`).get(`${dayAfter(lockedEnd)} 12:00:00`).t;
}

/**
 * Posts the take-back for one order, once. Safe to call from inside the caller's transaction. Returns the adjustment,
 * or null when there is nothing to take back (never commissioned, nothing was paid, or already reversed).
 */
function reverseForOrder({ orderId, reason, actorId = null }) {
  const paid = commissionPaidFor(orderId);
  if (!paid || paid.amount <= 0) return null;
  if (db.prepare('SELECT 1 FROM payroll_adjustments WHERE reverses_order_id = ?').get(orderId)) return null;

  const order = db.prepare('SELECT id, store_id, product_code FROM orders WHERE id = ?').get(orderId);
  if (!order) return null;
  const ref = order.product_code || `#${order.id}`;
  const notes = `Commission reversed on order ${ref}: ${reason}`;
  const at = reversalTimestamp(order.store_id);

  const result = db.prepare(`
    INSERT INTO payroll_adjustments (staff_id, store_id, type, amount, reverses_order_id, notes, created_by${at ? ', created_at' : ''})
    VALUES (?, ?, 'loss_deduction', ?, ?, ?, ?${at ? ', ?' : ''})
  `).run(...[paid.staffId, order.store_id, paid.amount, orderId, notes, actorId, ...(at ? [at] : [])]);
  const adjustment = db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(result.lastInsertRowid);

  logStaffAction({ staffId: actorId, action: 'create', entityType: 'commission_reversal', entityId: adjustment.id, after: { order_id: orderId, staff_id: paid.staffId, amount: paid.amount, reason } });
  notificationsService.notify({
    storeId: order.store_id, userIds: [paid.staffId], roles: ['admin', 'manager'], type: 'commission_reversed', severity: 'warning',
    title: `Commission reversed on order ${ref}`, body: reason, entityType: 'order', entityId: orderId, dedupeKey: `commission_reversed:${orderId}`,
  });
  return adjustment;
}

/**
 * The safety net behind the event hooks: finds every commissioned order whose sale no longer stands (not dispatched
 * and fully paid any more, or deleted) and reverses any not yet reversed. Run when a payroll draft is generated, so a
 * refund that reached the books by some route the hooks never see still comes off pay.
 */
function sweepReversals({ storeId, actorId = null }) {
  const rows = db.prepare(`
    SELECT co.order_id, o.status, o.deleted_at
      FROM commissioned_orders co JOIN orders o ON o.id = co.order_id
     WHERE o.store_id = ?
       AND NOT EXISTS (SELECT 1 FROM payroll_adjustments a WHERE a.reverses_order_id = co.order_id)
       AND (o.status <> 'dispatched_paid' OR o.amount_paid < o.total OR o.deleted_at IS NOT NULL)
  `).all(storeId);
  const done = [];
  for (const r of rows) {
    const why = r.deleted_at ? 'the order was deleted' : r.status === 'dispatched_paid' ? 'a payment on it was refunded' : `the order is now ${r.status.replace(/_/g, ' ')}`;
    const adj = reverseForOrder({ orderId: r.order_id, reason: why, actorId });
    if (adj) done.push(adj);
  }
  return done;
}

module.exports = { commissionPaidFor, reverseForOrder, sweepReversals };
