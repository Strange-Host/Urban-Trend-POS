const asyncHandler = require('../utils/asyncHandler');
const attendanceService = require('../services/attendance.service');

// POST /api/attendance/clock-in — self only, no target staff_id accepted;
// clocking someone else in isn't "attendance", it's fraud waiting to happen.
const clockIn = asyncHandler(async (req, res) => {
  const record = attendanceService.clockIn({ staffId: req.user.id, storeId: req.user.storeId });
  res.status(201).json({ data: record });
});

// POST /api/attendance/clock-out — self only, same reasoning.
const clockOut = asyncHandler(async (req, res) => {
  const record = attendanceService.clockOut({ staffId: req.user.id });
  // Snapshot what they're leaving open (and any note), and tell managers if it matters.
  const handover = require('../services/shift.service').recordHandover({
    userId: req.user.id, userName: req.user.name, storeId: req.user.storeId, trigger: 'clock_out', notes: req.body?.handover_notes,
  });
  res.json({ data: record, handover });
});

// GET /api/attendance/today?date=YYYY-MM-DD — admin/manager view of the whole store.
const listForDate = asyncHandler(async (req, res) => {
  const rows = attendanceService.listForDate({ storeId: req.user.storeId, workDate: req.query.date });
  res.json({ data: rows });
});

// GET /api/attendance/absences-today — §11: who simply never clocked in.
const absencesToday = asyncHandler(async (req, res) => {
  const rows = attendanceService.getAbsencesToday({ storeId: req.user.storeId });
  res.json({ data: rows });
});

module.exports = { clockIn, clockOut, listForDate, absencesToday };
