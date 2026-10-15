const db = require('../config/db');
const { hourNowSql } = require('../utils/storeTime');
const notificationsService = require('./notifications.service');
const attendanceService = require('./attendance.service');
const modules = require('./modules.service');

// "Open" for workload-balancing purposes — matches orders.service.js's own
// ACTIVE_STATUSES for orders; leads use their own equivalent since leads
// has a different status vocabulary (no shared enum to import from).
const OPEN_LEAD_STATUSES = ['new', 'contacted', 'rescheduled'];
const OPEN_ORDER_STATUSES = ['awaiting_dispatch', 'dispatched_unpaid', 'dispatched_partial'];

// §3 CRM Order Distribution Rules: "Logged in" AND "Marked as present" —
// this app doesn't have a separate presence toggle, so a clock-in IS
// presence (the same signal in both directions: no clock-in reasonably
// means "not here today").
function getEligibleStaff(storeId) {
  // With HR & back office switched off nobody clocks in, so "clocked in" would never be true and
  // every new lead/order would stay unassigned. Then every active cashier counts as present.
  if (!modules.isEnabled('hr')) {
    return db.prepare(`SELECT id, name FROM users WHERE store_id = ? AND role = 'cashier' AND is_active = 1`).all(storeId);
  }
  return db.prepare(`
    SELECT u.id, u.name FROM users u
    JOIN staff_attendance a ON a.staff_id = u.id
    WHERE u.store_id = ? AND u.role = 'cashier' AND u.is_active = 1
      AND a.work_date = ? AND a.clock_in_at IS NOT NULL
  `).all(storeId, attendanceService.todayDate());
}

function countOpenAssignments(table, openStatuses, staffId) {
  const placeholders = openStatuses.map(() => '?').join(',');
  return db.prepare(`
    SELECT COUNT(*) c FROM ${table} WHERE assigned_staff_id = ? AND status IN (${placeholders}) AND deleted_at IS NULL
  `).get(staffId, ...openStatuses).c;
}

// Equal distribution (§3): picks whoever among the eligible staff
// currently has the FEWEST open items in that table — not round-robin by
// turn order, since two staff finishing at different rates should still
// end up roughly balanced, which turn-order alone doesn't guarantee.
function pickLeastLoaded(storeId, table, openStatuses) {
  const eligible = getEligibleStaff(storeId);
  if (eligible.length === 0) return null;

  let best = null;
  let bestCount = Infinity;
  for (const staff of eligible) {
    const count = countOpenAssignments(table, openStatuses, staff.id);
    if (count < bestCount) {
      best = staff;
      bestCount = count;
    }
  }
  return best;
}

function autoAssignLead(storeId) {
  const staff = pickLeastLoaded(storeId, 'leads', OPEN_LEAD_STATUSES);
  return staff ? staff.id : null;
}

function autoAssignOrder(storeId) {
  const staff = pickLeastLoaded(storeId, 'orders', OPEN_ORDER_STATUSES);
  return staff ? staff.id : null;
}

// §3 10:00 AM Rule + §11 Unplanned Absences, same mechanism: anything
// still open and assigned to someone who never clocked in today gets
// handed to someone who did. Also sweeps up anything that's still
// unassigned (e.g. created before any staff had clocked in) — no reason
// to make an orphaned lead wait for a specific time of day once someone
// becomes available. Returns what it moved, for the caller to log/report.
function rebalanceStaleAssignments({ storeId, cutoffHour }) {
  const currentHour = parseInt(db.prepare(`SELECT ${hourNowSql()} AS h`).get().h, 10);
  const pastCutoff = currentHour >= (cutoffHour ?? 10);

  const moved = { leads: [], orders: [] };

  const reassignTable = (table, openStatuses, autoAssignFn) => {
    const placeholders = openStatuses.map(() => '?').join(',');
    // Unassigned: always eligible for a sweep, any time of day.
    const unassigned = db.prepare(`
      SELECT id FROM ${table} WHERE store_id = ? AND assigned_staff_id IS NULL AND status IN (${placeholders}) AND deleted_at IS NULL
    `).all(storeId, ...openStatuses);

    // Assigned to someone NOT clocked in today: only reassigned once
    // past the cutoff hour — matches "not logged in BY 10:00 AM".
    // (Attendance-based reassignment only makes sense while attendance is in use.)
    const staleAssigned = pastCutoff && modules.isEnabled('hr')
      ? db.prepare(`
          SELECT t.id FROM ${table} t
          WHERE t.store_id = ? AND t.assigned_staff_id IS NOT NULL AND t.status IN (${placeholders}) AND t.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM staff_attendance a
              WHERE a.staff_id = t.assigned_staff_id AND a.work_date = ? AND a.clock_in_at IS NOT NULL
            )
        `).all(storeId, ...openStatuses, attendanceService.todayDate())
      : [];

    for (const row of [...unassigned, ...staleAssigned]) {
      const newStaffId = autoAssignFn(storeId);
      if (!newStaffId) continue; // no one eligible yet — leave it, next sweep will retry
      db.prepare(`UPDATE ${table} SET assigned_staff_id = ?, updated_at = datetime('now') WHERE id = ?`).run(newStaffId, row.id);
      moved[table].push({ id: row.id, assignedStaffId: newStaffId });
      if (table === 'leads') {
        const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(row.id);
        notificationsService.notifyLeadAssigned({ lead, assignedStaffId: newStaffId, actorId: null });
      }
    }
  };

  reassignTable('leads', OPEN_LEAD_STATUSES, autoAssignLead);
  reassignTable('orders', OPEN_ORDER_STATUSES, autoAssignOrder);

  return moved;
}

module.exports = { getEligibleStaff, pickLeastLoaded, autoAssignLead, autoAssignOrder, rebalanceStaleAssignments };
