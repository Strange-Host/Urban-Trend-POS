const db = require('../config/db');
const { parsePagination, paginatedResponse } = require('../utils/paginate');

// GET /api/staff-logs?staff_id=&entity_type=&action=&from=&to=&page=&limit=
function listStaffLogs({ query }) {
  const { page, limit, offset } = parsePagination(query);
  const where = [];
  const params = [];

  if (query.staff_id) { where.push('l.staff_id = ?'); params.push(query.staff_id); }
  if (query.entity_type) { where.push('l.entity_type = ?'); params.push(query.entity_type); }
  if (query.action) { where.push('l.action = ?'); params.push(query.action); }
  if (query.from) { where.push('l.created_at >= ?'); params.push(query.from); }
  if (query.to) { where.push('l.created_at <= ?'); params.push(query.to); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT l.*, u.name AS staff_name
    FROM staff_logs l LEFT JOIN users u ON u.id = l.staff_id
    ${whereSql}
    ORDER BY l.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`SELECT COUNT(*) c FROM staff_logs l ${whereSql}`).get(...params).c;

  const data = rows.map((r) => ({ ...r, changes: JSON.parse(r.changes || '{}') }));
  return paginatedResponse({ rows: data, total, page, limit });
}

// GET /api/staff-logs/stats?from=&to=
function staffLogStats({ query }) {
  const where = [];
  const params = [];
  if (query.from) { where.push('created_at >= ?'); params.push(query.from); }
  if (query.to) { where.push('created_at <= ?'); params.push(query.to); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_actions,
      SUM(CASE WHEN action = 'create' THEN 1 ELSE 0 END) AS creates,
      SUM(CASE WHEN action = 'update' THEN 1 ELSE 0 END) AS updates,
      SUM(CASE WHEN action = 'delete' THEN 1 ELSE 0 END) AS deletes,
      COUNT(DISTINCT staff_id) AS active_staff
    FROM staff_logs ${whereSql}
  `).get(...params);

  return {
    data: {
      total_actions: totals.total_actions || 0,
      creates: totals.creates || 0,
      updates: totals.updates || 0,
      deletes: totals.deletes || 0,
      // "Active Staff" = staff with >=1 logged action in range (derivable straight from this table),
      // not staff.status = active — that's a separate concern belonging to the Staff module.
      active_staff: totals.active_staff || 0,
    },
  };
}

module.exports = { listStaffLogs, staffLogStats };
