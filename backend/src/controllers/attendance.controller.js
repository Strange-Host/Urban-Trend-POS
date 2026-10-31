const asyncHandler = require('../utils/asyncHandler');
const attendanceService = require('../services/attendance.service');
const shiftService = require('../services/shift.service');

// POST /api/attendance/clock-in — self only, no target staff_id accepted;
// clocking someone else in isn't "attendance", it's fraud waiting to happen.
const clockIn = asyncHandler(async (req, res) => {
  const record = attendanceService.clockIn({ staffId: req.user.id, storeId: req.user.storeId });
  res.status(201).json({ data: record });
});

// POST /api/attendance/clock-out — self only, same reasoning.
// Body: { confirm_all_dispatched, confirm_nairobi_reconciled, handover_notes }. The gate runs BEFORE the clock-out
// is written: a refusal (422) leaves the person clocked in, and the server checks each confirmation against the data.
const clockOut = asyncHandler(async (req, res) => {
  const body = req.body || {};
  attendanceService.assertClockedInNow(req.user.id);
  const gate = shiftService.assertCanClockOut({
    userId: req.user.id, storeId: req.user.storeId, notes: body.handover_notes,
    confirmations: { dispatched: body.confirm_all_dispatched === true, nairobi: body.confirm_nairobi_reconciled === true },
  });
  const record = attendanceService.clockOut({ staffId: req.user.id });
  // Store the handover (confirmations + note) for the manager's end-of-day review, and tell managers if it matters.
  const handover = shiftService.recordHandover({
    userId: req.user.id, userName: req.user.name, storeId: req.user.storeId, trigger: 'clock_out', notes: body.handover_notes,
    dispatchConfirmed: gate.dispatchConfirmed, nairobiConfirmed: gate.nairobiConfirmed,
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
