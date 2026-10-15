const db = require('../config/db');
const { todaySql } = require('../utils/storeTime');
const { logStaffAction } = require('../utils/auditLog');
const notificationsService = require('./notifications.service');

// Shift-close accountability. The older system's logout check asked staff
// about unfinished orders and parcels before they left; this is the same idea,
// built on the data this system already has. "Mine" means assigned to the
// signed-in rep (orders.assigned_staff_id / leads.assigned_staff_id).
const SAMPLE = 8;

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

  const unpaidWhere = `store_id = ? AND assigned_staff_id = ? AND deleted_at IS NULL AND status IN ('dispatched_unpaid','dispatched_partial')`;
  const unpaidParcels = db.prepare(`
    SELECT id, product_code, total, amount_paid, courier_type, dispatched_at FROM orders WHERE ${unpaidWhere} ORDER BY dispatched_at LIMIT ?
  `).all(storeId, userId, SAMPLE);
  const unpaid = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(total - amount_paid), 0) AS amount FROM orders WHERE ${unpaidWhere}`).get(storeId, userId);

  const leadWhere = `store_id = ? AND assigned_staff_id = ? AND deleted_at IS NULL AND (status = 'new'
      OR (status = 'rescheduled' AND follow_up_date IS NOT NULL AND follow_up_date <= ${todaySql()}))`;
  const leads = db.prepare(`SELECT id, name, phone, status, follow_up_date FROM leads WHERE ${leadWhere} ORDER BY created_at LIMIT ?`).all(storeId, userId, SAMPLE);
  const leadCount = db.prepare(`SELECT COUNT(*) AS n FROM leads WHERE ${leadWhere}`).get(storeId, userId).n;

  return {
    unconfirmed_cod: { count: unconfirmedCodCount, sample: unconfirmedCod },
    unpaid_parcels: { count: unpaid.n, amount: unpaid.amount, sample: unpaidParcels },
    leads_needing_action: { count: leadCount, sample: leads },
    has_open_items: unconfirmedCodCount + unpaid.n + leadCount > 0,
  };
}

/**
 * Called when someone clocks out or closes their cash session. Writes the
 * snapshot (and any note they typed) to the audit log, and — only when
 * something is genuinely left open — tells managers once per person per day.
 * Never throws into the clock-out / session-close that triggered it.
 */
function recordHandover({ userId, userName, storeId, trigger, notes }) {
  try {
    const summary = getHandover({ userId, storeId });
    const cleanNotes = typeof notes === 'string' ? notes.trim().slice(0, 500) : '';
    logStaffAction({
      staffId: userId, action: 'create', entityType: 'shift_handover', entityId: userId,
      after: {
        trigger, notes: cleanNotes || null,
        unconfirmed_cod: summary.unconfirmed_cod.count, unpaid_parcels: summary.unpaid_parcels.count,
        unpaid_amount: summary.unpaid_parcels.amount, leads_needing_action: summary.leads_needing_action.count,
        order_ids: [...summary.unconfirmed_cod.sample, ...summary.unpaid_parcels.sample].map((o) => o.id),
        lead_ids: summary.leads_needing_action.sample.map((l) => l.id),
      },
    });

    if (summary.has_open_items) {
      const parts = [];
      if (summary.unpaid_parcels.count) parts.push(`${summary.unpaid_parcels.count} unpaid parcel(s)`);
      if (summary.unconfirmed_cod.count) parts.push(`${summary.unconfirmed_cod.count} unconfirmed COD order(s)`);
      if (summary.leads_needing_action.count) parts.push(`${summary.leads_needing_action.count} lead(s) needing action`);
      const day = db.prepare(`SELECT ${todaySql()} AS d`).get().d;
      notificationsService.notify({
        storeId, roles: ['admin', 'manager'], type: 'shift_handover', severity: 'warning',
        title: `${userName || 'A staff member'} ended their shift with items still open`,
        body: parts.join(' · ') + (cleanNotes ? ` — "${cleanNotes}"` : ''),
        entityType: null, entityId: null, dedupeKey: `shift_handover:${userId}:${day}`,
      });
    }
    return summary;
  } catch (err) {
    require('../utils/logger').error('[shift] could not record handover', { userId, error: err.message });
    return null;
  }
}

module.exports = { getHandover, recordHandover };
