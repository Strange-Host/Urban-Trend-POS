const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const attendance = require('../services/attendance.service');
const shift = require('../services/shift.service');
const { auditV1 } = require('../utils/mobileAudit');

// The person's own shift. The same rules as the website: you can only clock yourself, and the clock-out gate (open orders,
// unreconciled Nairobi parcels, a handover note) is checked on the server before the clock-out is written.

const toIso = (s) => (s && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? `${s.replace(' ', 'T')}Z` : s || null);

function today(user) {
  const row = attendance.getForDate(user.id, attendance.todayDate());
  const status = !row || !row.clock_in_at ? 'not_started' : row.clock_out_at ? 'clocked_out' : 'clocked_in';
  let gate = null;
  if (status === 'clocked_in') {
    const h = shift.getHandover({ userId: user.id, storeId: user.storeId });
    gate = {
      mode: h.gate.mode, blocked: h.gate.blocked, reasonRequired: h.gate.reason_required,
      canConfirmDispatched: h.gate.can_confirm_dispatched, canConfirmNairobi: h.gate.can_confirm_nairobi,
      undispatchedOrders: h.undispatched_orders.count, nairobiUnpaid: h.nairobi_unpaid.count,
      custodyOpen: h.custody_open.count, unmatchedPayments: h.unmatched_payments.count,
    };
  }
  return { workDate: attendance.todayDate(), status, clockInAt: row ? toIso(row.clock_in_at) : null, clockOutAt: row ? toIso(row.clock_out_at) : null, gate };
}

const me = asyncHandler(async (req, res) => { res.json(today(req.user)); });

const clockIn = asyncHandler(async (req, res) => {
  if (req.body.confirm !== true) throw new ApiError(400, 'Confirm that you are clocking in.', null, 'CONFIRM_REQUIRED');
  const row = attendance.clockIn({ staffId: req.user.id, storeId: req.user.storeId });
  auditV1(req, { action: 'create', entityType: 'staff_attendance', entityId: row.id, after: { clock_in_at: row.clock_in_at } });
  res.status(201).json(today(req.user));
});

const clockOut = asyncHandler(async (req, res) => {
  const b = req.body;
  attendance.assertClockedInNow(req.user.id);
  const gate = shift.assertCanClockOut({
    userId: req.user.id, storeId: req.user.storeId, notes: b.handoverNotes,
    confirmations: { dispatched: b.confirmAllDispatched === true, nairobi: b.confirmNairobiReconciled === true },
  });
  const row = attendance.clockOut({ staffId: req.user.id });
  shift.recordHandover({
    userId: req.user.id, userName: req.user.name, storeId: req.user.storeId, trigger: 'clock_out', notes: b.handoverNotes,
    dispatchConfirmed: gate.dispatchConfirmed, nairobiConfirmed: gate.nairobiConfirmed,
  });
  auditV1(req, { action: 'update', entityType: 'staff_attendance', entityId: row.id, before: { clock_out_at: null }, after: { clock_out_at: row.clock_out_at }, reason: b.handoverNotes || null });
  res.json(today(req.user));
});

module.exports = { me, clockIn, clockOut };
