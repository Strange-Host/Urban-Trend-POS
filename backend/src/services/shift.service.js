const db = require('../config/db');
const { todaySql } = require('../utils/storeTime');
const { logStaffAction } = require('../utils/auditLog');
const notificationsService = require('./notifications.service');
const settingsService = require('./settings.service');
const ApiError = require('../utils/ApiError');

// Shift-close accountability. The older system's logout check asked staff
// about unfinished orders and parcels before they left; this is the same idea,
// built on the data this system already has. "Mine" means assigned to the
// signed-in rep (orders.assigned_staff_id / leads.assigned_staff_id).
//
// What the check covers when someone clocks out or closes their till:
//   - dispatched orders still unpaid or part paid (unpaid_parcels), with the Nairobi ones called out
//     separately (nairobi_unpaid) because those are the boda/cash-on-delivery payments that must be reconciled
//     the same day;
//   - COD orders not yet confirmed, and leads needing action;
//   - shop cash this person still holds and has not deposited (custody_open) - cash in a pocket is not
//     reconciled money;
//   - payments that arrived but could not be matched to any order (unmatched_payments). Those belong to the
//     whole shop rather than to one rep, so they are shown and logged but do not by themselves raise a manager alert;
//   - a free-text note for the manager. A note always reaches the managers, whether or not anything is open.
//
// Clock-out is a gate, not just a prompt (assertCanClockOut below). The person must confirm two things:
//   (1) every order assigned to them has been dispatched, and
//   (2) every Nairobi payment of theirs is reconciled.
// The server checks the claim against the data - ticking a box while orders are still awaiting dispatch is refused.
// If either is genuinely still open, clockout_gate_mode decides: 'reason' (default) lets them leave once they write why;
// 'block' keeps them in until it is cleared. Every handover is stored in shift_handovers for the manager's end-of-day review.
const SAMPLE = 8;

function clockOutGateMode() {
  return settingsService.getAll().clockout_gate_mode === 'block' ? 'block' : 'reason';
}

const MIN_REASON_LENGTH = 10;
const cleanNote = (notes) => (typeof notes === 'string' ? notes.trim().slice(0, 500) : '');

/**
 * The clock-out gate. Throws (422) if the person may not clock out as asked; otherwise returns what to record.
 * Call it BEFORE the clock-out is written, so a refusal leaves them clocked in.
 *
 *   confirmations: { dispatched, nairobi } booleans from the two checkboxes.
 */
function assertCanClockOut({ userId, storeId, confirmations = {}, notes }) {
  const summary = getHandover({ userId, storeId });
  const { gate } = summary;
  const note = cleanNote(notes);

  if (gate.blocked) {
    const parts = [];
    if (!gate.can_confirm_dispatched) parts.push(`${summary.undispatched_orders.count} assigned order(s) not yet dispatched`);
    if (!gate.can_confirm_nairobi) parts.push(`${summary.nairobi_unpaid.count} Nairobi payment(s) not yet reconciled`);
    throw new ApiError(422, `You can't clock out yet: ${parts.join(' and ')}. Clear them first, or ask a manager.`, null, 'CLOCKOUT_BLOCKED');
  }

  // A tick must be true. Claiming "all dispatched" with orders still waiting is refused rather than recorded.
  if (confirmations.dispatched && !gate.can_confirm_dispatched) {
    throw new ApiError(422, `${summary.undispatched_orders.count} order(s) assigned to you are still awaiting dispatch, so that can't be confirmed.`, null, 'CLOCKOUT_CONFIRMATION_FALSE');
  }
  if (confirmations.nairobi && !gate.can_confirm_nairobi) {
    throw new ApiError(422, `${summary.nairobi_unpaid.count} Nairobi payment(s) of yours are still not reconciled, so that can't be confirmed.`, null, 'CLOCKOUT_CONFIRMATION_FALSE');
  }

  // Each item is either confirmed (and true) or explained.
  const missing = [];
  if (gate.can_confirm_dispatched && !confirmations.dispatched) missing.push('confirm that all your assigned orders were dispatched');
  if (gate.can_confirm_nairobi && !confirmations.nairobi) missing.push('confirm that all your Nairobi payments are reconciled');
  if (missing.length) {
    throw new ApiError(422, `Before clocking out, please ${missing.join(' and ')}.`, null, 'CLOCKOUT_CONFIRMATION_REQUIRED');
  }
  if (gate.reason_required && note.length < MIN_REASON_LENGTH) {
    throw new ApiError(422, `Something is still open, so please write a short reason for your manager (at least ${MIN_REASON_LENGTH} characters).`, null, 'CLOCKOUT_REASON_REQUIRED');
  }

  return {
    summary,
    dispatchConfirmed: gate.can_confirm_dispatched && Boolean(confirmations.dispatched),
    nairobiConfirmed: gate.can_confirm_nairobi && Boolean(confirmations.nairobi),
  };
}

function getHandover({ userId, storeId }) {
  const unconfirmedCod = db.prepare(`
    SELECT id, product_code, total, created_at FROM orders
    WHERE store_id = ? AND assigned_staff_id = ? AND deleted_at IS NULL
      AND status = 'awaiting_dispatch' AND payment_type = 'cod' AND cod_confirmed_at IS NULL
    ORDER BY created_at LIMIT ?
  `).all(storeId, userId, SAMPLE);
  const unconfirmedCodCount = db.prepare(`
    SELECT COUNT(*) AS n FROM orders WHERE store_id = ? AND assigned_staff_id = ? AND deleted_at IS NULL
      AND status = 'awaiting_dispatch' AND payment_type = 'cod' AND cod_confirmed_at IS NULL
  `).get(storeId, userId).n;

  // Everything assigned to this person that has not left the shop yet. unconfirmed_cod above is a subset of this.
  const undispatchedWhere = `store_id = ? AND assigned_staff_id = ? AND deleted_at IS NULL AND status = 'awaiting_dispatch'`;
  const undispatchedSample = db.prepare(`
    SELECT id, product_code, total, payment_type, created_at FROM orders WHERE ${undispatchedWhere} ORDER BY created_at LIMIT ?
  `).all(storeId, userId, SAMPLE);
  const undispatchedCount = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE ${undispatchedWhere}`).get(storeId, userId).n;

  const unpaidWhere = `store_id = ? AND assigned_staff_id = ? AND deleted_at IS NULL AND status IN ('dispatched_unpaid','dispatched_partial')`;
  const unpaidParcels = db.prepare(`
    SELECT id, product_code, total, amount_paid, courier_type, dispatched_at FROM orders WHERE ${unpaidWhere} ORDER BY dispatched_at LIMIT ?
  `).all(storeId, userId, SAMPLE);
  const unpaid = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total - amount_paid), 0) AS amount FROM orders WHERE ${unpaidWhere}`).get(storeId, userId);

  const nairobiWhere = `${unpaidWhere} AND delivery_zone = 'nairobi'`;
  const nairobiSample = db.prepare(`
    SELECT id, product_code, total, amount_paid, courier_type, dispatched_at FROM orders WHERE ${nairobiWhere} ORDER BY dispatched_at LIMIT ?
  `).all(storeId, userId, SAMPLE);
  const nairobi = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total - amount_paid), 0) AS amount FROM orders WHERE ${nairobiWhere}`).get(storeId, userId);

  const custodyWhere = `store_id = ? AND holder_staff_id = ? AND status = 'open'`;
  const custodySample = db.prepare(`SELECT id, order_id, amount, reason, opened_at FROM custody_records WHERE ${custodyWhere} ORDER BY opened_at LIMIT ?`).all(storeId, userId, SAMPLE);
  const custody = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM custody_records WHERE ${custodyWhere}`).get(storeId, userId);

  const unmatched = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM payment_notifications
     WHERE store_id = ? AND direction = 'incoming' AND status = 'unmatched'
  `).get(storeId);

  const leadWhere = `store_id = ? AND assigned_staff_id = ? AND deleted_at IS NULL AND (status = 'new'
      OR (status = 'rescheduled' AND follow_up_date IS NOT NULL AND follow_up_date <= ${todaySql()}))`;
  const leads = db.prepare(`SELECT id, name, phone, status, follow_up_date FROM leads WHERE ${leadWhere} ORDER BY created_at LIMIT ?`).all(storeId, userId, SAMPLE);
  const leadCount = db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE ${leadWhere}`).get(storeId, userId).n;

  const gateMode = clockOutGateMode();
  const dispatchedClear = undispatchedCount === 0;
  const nairobiClear = nairobi.n === 0;

  return {
    undispatched_orders: { count: undispatchedCount, sample: undispatchedSample },
    // What the clock-out screen needs to know: which confirmations are honest right now, and what happens if they are not.
    gate: {
      mode: gateMode,
      can_confirm_dispatched: dispatchedClear,
      can_confirm_nairobi: nairobiClear,
      reason_required: !dispatchedClear || !nairobiClear,
      blocked: gateMode === 'block' && (!dispatchedClear || !nairobiClear),
    },
    unconfirmed_cod: { count: unconfirmedCodCount, sample: unconfirmedCod },
    unpaid_parcels: { count: unpaid.n, amount: unpaid.amount, sample: unpaidParcels },
    nairobi_unpaid: { count: nairobi.n, amount: nairobi.amount, sample: nairobiSample },
    custody_open: { count: custody.n, amount: custody.amount, sample: custodySample },
    unmatched_payments: { count: unmatched.n, amount: unmatched.amount },
    leads_needing_action: { count: leadCount, sample: leads },
    has_open_items: undispatchedCount + unconfirmedCodCount + unpaid.n + leadCount + custody.n > 0,
  };
}

/**
 * Called when someone clocks out or closes their cash session. Writes the
 * snapshot (and any note they typed) to the audit log, and — only when
 * something is genuinely left open — tells managers once per person per day.
 * Never throws into the clock-out / session-close that triggered it.
 */
function recordHandover({ userId, userName, storeId, trigger, notes, dispatchConfirmed = false, nairobiConfirmed = false }) {
  try {
    const summary = getHandover({ userId, storeId });
    const cleanNotes = cleanNote(notes);
    // The row the manager's end-of-day review reads. Written first, so the note is stored even if anything after it fails.
    const day = db.prepare(`SELECT ${todaySql()} AS d`).get().d;
    const otherOpen = summary.unpaid_parcels.count + summary.unconfirmed_cod.count + summary.leads_needing_action.count + summary.custody_open.count;
    db.prepare(`
      INSERT INTO shift_handovers (store_id, staff_id, work_date, trigger, notes, dispatch_confirmed, nairobi_confirmed,
        undispatched_count, nairobi_unpaid_count, nairobi_unpaid_amount, other_open_count, snapshot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(storeId, userId, day, trigger, cleanNotes || null, dispatchConfirmed ? 1 : 0, nairobiConfirmed ? 1 : 0,
      summary.undispatched_orders.count, summary.nairobi_unpaid.count, summary.nairobi_unpaid.amount, otherOpen, JSON.stringify(summary));

    logStaffAction({
      staffId: userId, action: 'create', entityType: 'shift_handover', entityId: userId,
      after: {
        trigger, notes: cleanNotes || null, dispatch_confirmed: dispatchConfirmed, nairobi_confirmed: nairobiConfirmed,
        undispatched_orders: summary.undispatched_orders.count,
        unconfirmed_cod: summary.unconfirmed_cod.count, unpaid_parcels: summary.unpaid_parcels.count,
        unpaid_amount: summary.unpaid_parcels.amount, leads_needing_action: summary.leads_needing_action.count,
        nairobi_unpaid: summary.nairobi_unpaid.count, nairobi_unpaid_amount: summary.nairobi_unpaid.amount,
        custody_open: summary.custody_open.count, custody_open_amount: summary.custody_open.amount,
        unmatched_payments: summary.unmatched_payments.count,
        order_ids: [...summary.unconfirmed_cod.sample, ...summary.unpaid_parcels.sample].map((o) => o.id),
        lead_ids: summary.leads_needing_action.sample.map((l) => l.id),
      },
    });

    const who = userName || 'A staff member';
    if (summary.has_open_items) {
      const parts = [];
      if (summary.undispatched_orders.count) parts.push(`${summary.undispatched_orders.count} order(s) not dispatched`);
      if (summary.unpaid_parcels.count) {
        parts.push(`${summary.unpaid_parcels.count} unpaid parcel(s)${summary.nairobi_unpaid.count ? ` (${summary.nairobi_unpaid.count} in Nairobi)` : ''}`);
      }
      if (summary.unconfirmed_cod.count) parts.push(`${summary.unconfirmed_cod.count} unconfirmed COD order(s)`);
      if (summary.custody_open.count) parts.push(`${summary.custody_open.count} shop cash record(s) not deposited`);
      if (summary.leads_needing_action.count) parts.push(`${summary.leads_needing_action.count} lead(s) needing action`);
      notificationsService.notify({
        storeId, roles: ['admin', 'manager'], type: 'shift_handover', severity: 'warning',
        title: `${who} ended their shift with items still open`,
        body: parts.join(' · ') + (cleanNotes ? ` — "${cleanNotes}"` : ''),
        entityType: null, entityId: null, dedupeKey: `shift_handover:${userId}:${day}:${trigger}`,
      });
    } else if (cleanNotes) {
      // Nothing open, but they left a note for the manager: it must not sit unseen in the activity log.
      notificationsService.notify({
        storeId, roles: ['admin', 'manager'], type: 'shift_note', severity: 'info',
        title: `${who} left a note at the end of their shift`, body: cleanNotes,
        entityType: null, entityId: null, dedupeKey: `shift_note:${userId}:${day}:${trigger}`,
      });
    }
    return summary;
  } catch (err) {
    require('../utils/logger').error('[shift] could not record handover', { userId, error: err.message });
    return null;
  }
}

module.exports = { getHandover, recordHandover, assertCanClockOut, clockOutGateMode };
