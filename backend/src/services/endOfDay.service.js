const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const attendanceService = require('./attendance.service');
const settingsService = require('./settings.service');
const notificationsService = require('./notifications.service');
const { logStaffAction } = require('../utils/auditLog');
const { sqlOffset } = require('../utils/storeTime');

// The manager's end-of-day review: one view that puts together what the spec says a manager must see before approving
// the day - what was reassigned, who was absent or late, and what each employee left in their handover note.
// Approving writes one end_of_day_reviews row per shop per day, with a frozen copy of what the manager was looking at.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function resolveDate(date) {
  if (date === undefined || date === null || date === '') return attendanceService.todayDate();
  if (!DATE_RE.test(String(date)) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new ApiError(400, 'date must be YYYY-MM-DD.');
  }
  return String(date);
}

// Whole hours past the workday start the person clocked in, on the shop clock (clock_in_at is stored in UTC).
// Same rule payroll uses for the late fee, so the manager sees what payroll will charge.
function hoursLate(clockInAt, startHour) {
  if (!clockInAt) return 0;
  const t = db.prepare(`SELECT strftime('%H', ?, ${sqlOffset()}) AS h, strftime('%M', ?, ${sqlOffset()}) AS m`).get(clockInAt, clockInAt);
  const hoursIn = parseInt(t.h, 10) + parseInt(t.m, 10) / 60;
  return hoursIn > startHour ? Math.ceil(hoursIn - startHour) : 0;
}

function getDay({ storeId, date }) {
  const workDate = resolveDate(date);
  const startHour = parseInt(settingsService.getAll().attendance_workday_start_hour, 10);

  const attendance = attendanceService.listForDate({ storeId, workDate }).map((row) => ({
    staff_id: row.staff_id, name: row.name,
    status: row.clock_in_at ? 'present' : 'absent',
    hours_late: hoursLate(row.clock_in_at, startHour),
    clock_in_at: row.clock_in_at, clock_out_at: row.clock_out_at,
  }));

  const moves = db.prepare(`
    SELECT m.id, m.entity_type, m.entity_id, m.reason, m.created_at,
           m.from_staff_id, fu.name AS from_name, m.to_staff_id, tu.name AS to_name
    FROM assignment_moves m
    LEFT JOIN users fu ON fu.id = m.from_staff_id
    JOIN users tu ON tu.id = m.to_staff_id
    WHERE m.store_id = ? AND m.work_date = ? ORDER BY m.id
  `).all(storeId, workDate);

  const handovers = db.prepare(`
    SELECT h.id, h.staff_id, u.name AS staff_name, h.trigger, h.notes, h.dispatch_confirmed, h.nairobi_confirmed,
           h.undispatched_count, h.nairobi_unpaid_count, h.nairobi_unpaid_amount, h.other_open_count, h.created_at
    FROM shift_handovers h JOIN users u ON u.id = h.staff_id
    WHERE h.store_id = ? AND h.work_date = ? ORDER BY h.id
  `).all(storeId, workDate).map((h) => ({
    ...h,
    dispatch_confirmed: !!h.dispatch_confirmed,
    nairobi_confirmed: !!h.nairobi_confirmed,
    // Left with something unresolved (they wrote a reason instead of confirming).
    has_exception: !h.dispatch_confirmed || !h.nairobi_confirmed,
  }));

  // Clocked in but no clock-out handover on file: the manager should see that gap, not assume "no note" means "nothing to say".
  const noHandover = attendance
    .filter((a) => a.clock_in_at && !handovers.some((h) => h.staff_id === a.staff_id && h.trigger === 'clock_out'))
    .map((a) => ({ staff_id: a.staff_id, name: a.name, clocked_out: Boolean(a.clock_out_at) }));

  const review = db.prepare(`
    SELECT r.id, r.work_date, r.note, r.created_at, r.reviewed_by, u.name AS reviewed_by_name
    FROM end_of_day_reviews r JOIN users u ON u.id = r.reviewed_by
    WHERE r.store_id = ? AND r.work_date = ?
  `).get(storeId, workDate) || null;

  const summary = {
    absent: attendance.filter((a) => a.status === 'absent').length,
    late: attendance.filter((a) => a.hours_late > 0).length,
    reassigned: moves.length,
    handovers: handovers.length,
    handover_exceptions: handovers.filter((h) => h.has_exception).length,
    notes: handovers.filter((h) => h.notes).length,
  };
  const somethingToReview = summary.absent + summary.late + summary.reassigned + summary.handover_exceptions + summary.notes + noHandover.length > 0;

  return {
    work_date: workDate, attendance, moves, handovers, no_handover: noHandover, summary,
    needs_acknowledgement: somethingToReview && !review,
    review,
  };
}

/**
 * Approve the day. One approval per shop per day (a second attempt is a 409, never a silent overwrite).
 * When there is anything to look at, the manager must say they reviewed it (acknowledged: true).
 */
function approve({ storeId, userId, userName, date, note, acknowledged }) {
  const day = getDay({ storeId, date });
  if (day.work_date > attendanceService.todayDate()) throw new ApiError(422, 'A day cannot be approved before it happens.', null, 'EOD_FUTURE_DATE');
  if (day.review) throw new ApiError(409, `${day.work_date} has already been approved.`, null, 'EOD_ALREADY_APPROVED');

  const stillIn = day.attendance.filter((a) => a.clock_in_at && !a.clock_out_at).map((a) => a.name);
  if (stillIn.length) {
    throw new ApiError(422, `Can't approve ${day.work_date} yet: ${stillIn.join(', ')} ${stillIn.length === 1 ? 'is' : 'are'} still clocked in.`, null, 'EOD_STAFF_STILL_CLOCKED_IN');
  }
  if (day.needs_acknowledgement && acknowledged !== true) {
    throw new ApiError(422, 'Please confirm you have reviewed the reassigned work, attendance and handover notes.', null, 'EOD_ACKNOWLEDGEMENT_REQUIRED');
  }

  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 500) : '';
  const { review: _none, needs_acknowledgement: _ack, ...frozen } = day;
  const result = db.prepare(`
    INSERT INTO end_of_day_reviews (store_id, work_date, reviewed_by, note, snapshot) VALUES (?, ?, ?, ?, ?)
  `).run(storeId, day.work_date, userId, cleanNote || null, JSON.stringify(frozen));
  logStaffAction({
    staffId: userId, action: 'create', entityType: 'end_of_day_review', entityId: result.lastInsertRowid,
    after: { work_date: day.work_date, note: cleanNote || null, ...day.summary },
  });
  notificationsService.notify({
    storeId, roles: ['admin'], type: 'end_of_day_approved', title: `Day approved: ${day.work_date}`,
    body: `${userName || 'A manager'} approved the end-of-day report: ${day.summary.absent} absent, ${day.summary.reassigned} reassigned, ${day.summary.handover_exceptions} left with open items.`,
    entityType: 'end_of_day_review', entityId: result.lastInsertRowid, dedupeKey: `eod-approved:${storeId}:${day.work_date}`,
  });
  return getDay({ storeId, date: day.work_date });
}

module.exports = { getDay, approve };
