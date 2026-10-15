const db = require('../config/db');
const { todaySql } = require('../utils/storeTime');
const ApiError = require('../utils/ApiError');

// The shop's calendar date (Nairobi, UTC+3 - see utils/storeTime.js), not the UTC date:
// someone clocking in at 7 am must land on today, not yesterday.
function todayDate() {
  return db.prepare(`SELECT ${todaySql()} AS d`).get().d;
}

function getForDate(staffId, workDate) {
  return db.prepare('SELECT * FROM staff_attendance WHERE staff_id = ? AND work_date = ?').get(staffId, workDate);
}

function clockIn({ staffId, storeId }) {
  const workDate = todayDate();
  const existing = getForDate(staffId, workDate);
  if (existing && existing.clock_in_at) throw new ApiError(409, 'Already clocked in today.');

  if (existing) {
    db.prepare(`UPDATE staff_attendance SET clock_in_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(existing.id);
    return getForDate(staffId, workDate);
  }
  const result = db.prepare(`
    INSERT INTO staff_attendance (staff_id, store_id, work_date, clock_in_at) VALUES (?, ?, ?, datetime('now'))
  `).run(staffId, storeId, workDate);
  return db.prepare('SELECT * FROM staff_attendance WHERE id = ?').get(result.lastInsertRowid);
}

function clockOut({ staffId }) {
  const workDate = todayDate();
  const existing = getForDate(staffId, workDate);
  if (!existing || !existing.clock_in_at) throw new ApiError(409, 'Not clocked in today.');
  if (existing.clock_out_at) throw new ApiError(409, 'Already clocked out today.');

  db.prepare(`UPDATE staff_attendance SET clock_out_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(existing.id);
  return getForDate(staffId, workDate);
}

function isClockedInToday(staffId) {
  const row = getForDate(staffId, todayDate());
  return !!(row && row.clock_in_at);
}

function listForDate({ storeId, workDate }) {
  const date = workDate || todayDate();
  return db.prepare(`
    SELECT u.id AS staff_id, u.name, u.role, a.clock_in_at, a.clock_out_at
    FROM users u
    LEFT JOIN staff_attendance a ON a.staff_id = u.id AND a.work_date = ?
    WHERE u.store_id = ? AND u.is_active = 1 AND u.role = 'cashier'
    ORDER BY u.name
  `).all(date, storeId);
}

// §11 Unplanned Absences: anyone active who simply never clocked in today.
// Feeds both the management-visible list (GET /api/attendance/absences-today)
// and telesalesDistribution.service's reassignment sweep.
function getAbsencesToday({ storeId }) {
  return listForDate({ storeId }).filter((row) => !row.clock_in_at);
}

module.exports = { todayDate, clockIn, clockOut, isClockedInToday, listForDate, getAbsencesToday, getForDate };
