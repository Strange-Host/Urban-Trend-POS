const notificationsService = require('./notifications.service');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { normalizePhone } = require('../utils/phone');
const { logStaffAction } = require('../utils/auditLog');
const telesalesDistribution = require('./telesalesDistribution.service');

// State machine (§1.2) — the only legal transitions. `converted` and
// `cancelled` are terminal; reopening a cancelled lead must go through
// reactivate(), which creates a fresh history entry rather than a silent flip.
const TRANSITIONS = {
  new: ['contacted', 'cancelled'],
  contacted: ['rescheduled', 'converted', 'cancelled'],
  rescheduled: ['contacted', 'converted', 'cancelled'],
  converted: [],
  cancelled: [],
};

const VALID_SOURCES = ['whatsapp', 'walk_in', 'referral', 'shopify', 'other'];
const VALID_ACTIVITY_TYPES = ['call', 'message', 'meeting', 'note'];

function assertValidTransition(from, to) {
  const allowed = TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new ApiError(
      409,
      `Cannot move a lead from "${from}" to "${to}". Valid next states: ${allowed.length ? allowed.join(', ') : 'none — this status is terminal'}.`
    );
  }
}

function findDuplicateByPhone({ storeId, phone }) {
  const phoneNormalized = normalizePhone(phone);
  return db.prepare(`
    SELECT * FROM leads WHERE store_id = ? AND phone_normalized = ? AND deleted_at IS NULL
  `).get(storeId, phoneNormalized);
}

// Cashiers only see/manage their own assigned leads (§5.2: "own assigned leads only").
function scopeToRole(where, params, { role, userId }) {
  if (role === 'cashier') {
    where.push('assigned_staff_id = ?');
    params.push(userId);
  }
}

function list({ storeId, role, userId, status, source, assignedStaffId, search, limit, offset }) {
  const where = ['l.deleted_at IS NULL', 'l.store_id = ?'];
  const params = [storeId];

  if (status) { where.push('l.status = ?'); params.push(status); }
  if (source) { where.push('l.source = ?'); params.push(source); }
  if (assignedStaffId) { where.push('l.assigned_staff_id = ?'); params.push(assignedStaffId); }
  if (search) {
    where.push('(l.name LIKE ? OR l.phone LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term);
  }
  scopeToRole(where, params, { role, userId });
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = db.prepare(`
    SELECT l.*, u.name AS assigned_staff_name,
      (SELECT MAX(created_at) FROM lead_activities WHERE lead_id = l.id) AS last_activity_at
    FROM leads l LEFT JOIN users u ON u.id = l.assigned_staff_id
    ${whereSql}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) c FROM leads l ${whereSql}`).get(...params).c;
  return { rows, total };
}

function getStats({ storeId, role, userId }) {
  const where = ['deleted_at IS NULL', 'store_id = ?'];
  const params = [storeId];
  scopeToRole(where, params, { role, userId });
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = db.prepare(`SELECT status, COUNT(*) c FROM leads ${whereSql} GROUP BY status`).all(...params);
  const total = db.prepare(`SELECT COUNT(*) c FROM leads ${whereSql}`).get(...params).c;

  const byStatus = { new: 0, contacted: 0, rescheduled: 0, converted: 0, cancelled: 0 };
  rows.forEach((r) => { byStatus[r.status] = r.c; });
  return { total, ...byStatus };
}

function getById({ id, storeId, role, userId }) {
  const where = ['id = ?', 'deleted_at IS NULL', 'store_id = ?'];
  const params = [id, storeId];
  scopeToRole(where, params, { role, userId });

  const lead = db.prepare(`SELECT * FROM leads WHERE ${where.join(' AND ')}`).get(...params);
  if (!lead) return null;

  const activities = db.prepare(`
    SELECT a.*, u.name AS staff_name FROM lead_activities a
    LEFT JOIN users u ON u.id = a.staff_id
    WHERE a.lead_id = ? ORDER BY a.created_at DESC
  `).all(lead.id);

  const statusHistory = db.prepare(`
    SELECT h.*, u.name AS changed_by_name FROM lead_status_history h
    LEFT JOIN users u ON u.id = h.changed_by_staff_id
    WHERE h.lead_id = ? ORDER BY h.changed_at DESC
  `).all(lead.id);

  return { ...lead, activities, status_history: statusHistory };
}

function create({ storeId, staffId, name, phone, email, source, notes, assignedStaffId }) {
  if (!name || !phone || !source) throw new ApiError(400, 'name, phone, and source are required.');
  if (!VALID_SOURCES.includes(source)) {
    throw new ApiError(400, `source must be one of ${VALID_SOURCES.join(', ')}.`);
  }

  // Duplicate detection (§1.2) — never silently merge, surface a 409 with the existing id.
  const duplicate = findDuplicateByPhone({ storeId, phone });
  if (duplicate) {
    throw new ApiError(409, 'A lead with this phone number already exists.', { existingLeadId: duplicate.id });
  }

  // §3 Equal Distribution: an explicit assignedStaffId always wins (a
  // manager picking someone specific is intentional); only auto-assign
  // when nobody was named, and only if a currently-eligible (clocked-in)
  // telesales rep actually exists — otherwise this stays unassigned and
  // telesalesDistribution's sweep picks it up once someone clocks in.
  const finalAssignedStaffId = assignedStaffId || telesalesDistribution.autoAssignLead(storeId);

  const result = db.prepare(`
    INSERT INTO leads (store_id, name, phone, phone_normalized, email, source, assigned_staff_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(storeId, name, phone, normalizePhone(phone), email || null, source, finalAssignedStaffId || null, notes || null);

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId, action: 'create', entityType: 'lead', entityId: lead.id, after: lead });
  notificationsService.notifyLeadAssigned({ lead, assignedStaffId: finalAssignedStaffId, actorId: staffId });
  return lead;
}

function update({ id, storeId, role, userId, staffId, name, phone, email, notes, assignedStaffId, convertedOrderId }) {
  const where = ['id = ?', 'deleted_at IS NULL', 'store_id = ?'];
  const params = [id, storeId];
  scopeToRole(where, params, { role, userId });
  const existing = db.prepare(`SELECT * FROM leads WHERE ${where.join(' AND ')}`).get(...params);
  if (!existing) return null;

  const finalName = name ?? existing.name;
  const finalPhone = phone ?? existing.phone;
  const finalEmail = email ?? existing.email;
  const finalNotes = notes ?? existing.notes;
  const finalAssignedStaffId = assignedStaffId ?? existing.assigned_staff_id;
  const finalConvertedOrderId = convertedOrderId ?? existing.converted_order_id;

  db.prepare(`
    UPDATE leads SET name=?, phone=?, phone_normalized=?, email=?, notes=?, assigned_staff_id=?, converted_order_id=?, updated_at=datetime('now')
    WHERE id=?
  `).run(finalName, finalPhone, normalizePhone(finalPhone), finalEmail, finalNotes, finalAssignedStaffId, finalConvertedOrderId, id);

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  logStaffAction({ staffId, action: 'update', entityType: 'lead', entityId: lead.id, before: existing, after: lead });
  if (lead.assigned_staff_id !== existing.assigned_staff_id) {
    notificationsService.notifyLeadAssigned({ lead, assignedStaffId: lead.assigned_staff_id, actorId: staffId });
  }
  return lead;
}

// Changing status writes lead_status_history AND a lead_activities row
// automatically — staff never have to log the status_change activity by hand (§1.2).
function changeStatus({ leadId, storeId, role, userId, toStatus, staffId, followUpDate }) {
  const txn = db.transaction(() => {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(leadId, storeId);
    if (!lead) throw new ApiError(404, 'Lead not found.');
    if (role === 'cashier' && lead.assigned_staff_id !== userId) {
      throw new ApiError(403, 'You can only update leads assigned to you.');
    }

    assertValidTransition(lead.status, toStatus);

    if (toStatus === 'rescheduled' && !followUpDate) {
      throw new ApiError(400, 'follow_up_date is required when moving a lead to rescheduled.');
    }

    db.prepare(`
      UPDATE leads SET status = ?, follow_up_date = ?, updated_at = datetime('now') WHERE id = ?
    `).run(toStatus, toStatus === 'rescheduled' ? followUpDate : null, leadId);

    db.prepare(`
      INSERT INTO lead_status_history (lead_id, from_status, to_status, changed_by_staff_id)
      VALUES (?, ?, ?, ?)
    `).run(leadId, lead.status, toStatus, staffId);

    db.prepare(`
      INSERT INTO lead_activities (lead_id, type, content, staff_id)
      VALUES (?, 'status_change', ?, ?)
    `).run(leadId, `Status changed from ${lead.status} to ${toStatus}`, staffId);

    logStaffAction({
      staffId,
      action: 'update',
      entityType: 'lead',
      entityId: leadId,
      before: { status: lead.status },
      after: { status: toStatus },
    });

    return db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  });

  return txn();
}

function addActivity({ id, storeId, role, userId, type, content, staffId }) {
  if (!type || !VALID_ACTIVITY_TYPES.includes(type)) {
    throw new ApiError(400, `type must be one of ${VALID_ACTIVITY_TYPES.join(', ')}.`);
  }

  const where = ['id = ?', 'deleted_at IS NULL', 'store_id = ?'];
  const params = [id, storeId];
  scopeToRole(where, params, { role, userId });
  const lead = db.prepare(`SELECT * FROM leads WHERE ${where.join(' AND ')}`).get(...params);
  if (!lead) return null;

  const result = db.prepare(`
    INSERT INTO lead_activities (lead_id, type, content, staff_id) VALUES (?, ?, ?, ?)
  `).run(id, type, content || null, staffId);

  return db.prepare('SELECT * FROM lead_activities WHERE id = ?').get(result.lastInsertRowid);
}

function remove({ id, storeId, staffId }) {
  const existing = db.prepare('SELECT * FROM leads WHERE id = ? AND store_id = ? AND deleted_at IS NULL').get(id, storeId);
  if (!existing) return false;

  db.prepare(`UPDATE leads SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  logStaffAction({ staffId, action: 'delete', entityType: 'lead', entityId: existing.id, before: existing });
  return true;
}

module.exports = {
  TRANSITIONS, assertValidTransition, findDuplicateByPhone,
  list, getStats, getById, create, update, changeStatus, addActivity, remove,
};
