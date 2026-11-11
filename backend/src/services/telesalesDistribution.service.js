const db = require('../config/db');
const notificationsService = require('./notifications.service');

// "Open" for workload-balancing purposes — matches orders.service.js's own
// ACTIVE_STATUSES for orders; leads use their own equivalent since leads
// has a different status vocabulary (no shared enum to import from).
const OPEN_LEAD_STATUSES = ['new', 'contacted', 'rescheduled'];
const OPEN_ORDER_STATUSES = ['awaiting_dispatch', 'dispatched_unpaid', 'dispatched_partial'];

// §3 CRM Order Distribution Rules: new leads and orders are shared out among the active cashiers of the branch.
// Nobody clocks in on this system, so every active cashier counts as present.
function getEligibleStaff(storeId) {
  return db.prepare(`SELECT id, name FROM users WHERE store_id = ? AND role = 'cashier' AND is_active = 1`).all(storeId);
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

// Sweeps up any open lead or order that nobody was assigned (e.g. created before a cashier existed) and shares it out
// to the least loaded active cashier. Returns what it moved, for the caller to log/report.
function rebalanceStaleAssignments({ storeId }) {
  const moved = { leads: [], orders: [] };

  const reassignTable = (table, openStatuses, autoAssignFn) => {
    const placeholders = openStatuses.map(() => '?').join(',');
    const unassigned = db.prepare(`
      SELECT id FROM ${table} WHERE store_id = ? AND assigned_staff_id IS NULL AND status IN (${placeholders}) AND deleted_at IS NULL
    `).all(storeId, ...openStatuses);

    for (const row of unassigned) {
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
