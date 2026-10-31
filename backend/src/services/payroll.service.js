const db = require('../config/db');
const { dateOf, sqlOffset } = require('../utils/storeTime');
const ApiError = require('../utils/ApiError');
const settingsService = require('./settings.service');
const { securedOrders } = require('./commission.service');
const payTerms = require('./payTerms.service');
const { sameMonth } = require('../utils/payCycle');

// §12 Attendance & Deductions, computed fresh from staff_attendance every
// time — see payroll_adjustments' comment in schema.sql for why this isn't
// a posted ledger. Each attendance row in range becomes: an absence fee
// (no clock_in_at at all), a late fee (clocked in after the configured
// start hour), and/or a missing-hours fee (clocked out short of the
// expected day) — a day can incur late AND missing-hours together, but
// never absence alongside either (absence means no clock-in existed).
function computeAttendanceDeductions({ staffId, periodStart, periodEnd, settings }) {
  const startHour = parseInt(settings.attendance_workday_start_hour, 10);
  const lateFeePerHour = parseInt(settings.attendance_late_fee_per_hour_kes, 10) * 100;
  const absenceFee = parseInt(settings.attendance_absence_fee_kes, 10) * 100;
  const expectedHours = parseFloat(settings.attendance_expected_hours);
  const missingHourFee = parseInt(settings.attendance_missing_hour_fee_kes, 10) * 100;

  const rows = db.prepare(`
    SELECT * FROM staff_attendance WHERE staff_id = ? AND work_date BETWEEN ? AND ? ORDER BY work_date
  `).all(staffId, periodStart, periodEnd);

  let daysLoggedIn = 0;
  const loggedInDates = [];
  let absenceTotal = 0;
  let lateTotal = 0;
  let missingHoursTotal = 0;
  const breakdown = [];

  for (const row of rows) {
    if (!row.clock_in_at) {
      absenceTotal += absenceFee;
      breakdown.push({ date: row.work_date, type: 'absence', amount: absenceFee });
      continue;
    }
    daysLoggedIn += 1;
    loggedInDates.push(row.work_date);

    // clock_in_at is stored in UTC; the shift start hour is the SHOP's clock (Nairobi, UTC+3).
    // Measure the hour on the shop clock, or 8:00 am local (05:00 UTC) would look like 5 and never be late.
    // Whole seconds (not julianday fractions, which carry float noise: exactly 08:00:00 came out as
    // 8.0000000001 and was charged an hour late).
    const clockInHour = db.prepare(
      `SELECT (CAST(strftime('%s', datetime(?, ${sqlOffset()})) AS INTEGER) - CAST(strftime('%s', date(?, ${sqlOffset()})) AS INTEGER)) / 3600.0 AS h`
    ).get(row.clock_in_at, row.clock_in_at).h;
    if (clockInHour > startHour) {
      const hoursLate = Math.ceil(clockInHour - startHour);
      const lateFee = hoursLate * lateFeePerHour;
      lateTotal += lateFee;
      breakdown.push({ date: row.work_date, type: 'late', hoursLate, amount: lateFee });
    }

    if (row.clock_out_at) {
      const hoursWorked = db.prepare(`SELECT (CAST(strftime('%s', ?) AS INTEGER) - CAST(strftime('%s', ?) AS INTEGER)) / 3600.0 AS h`).get(row.clock_out_at, row.clock_in_at).h;
      if (hoursWorked < expectedHours) {
        const hoursMissing = Math.ceil(expectedHours - hoursWorked);
        const missingFee = hoursMissing * missingHourFee;
        missingHoursTotal += missingFee;
        breakdown.push({ date: row.work_date, type: 'missing_hours', hoursMissing, amount: missingFee });
      }
    }
  }

  return { daysLoggedIn, loggedInDates, absenceTotal, lateTotal, missingHoursTotal, breakdown };
}

// §6 Commission tiers — see settings.service.js DEFAULTS for the "best
// guess pending confirmation" caveat on the actual numbers. Achievement is
// this staff member's SECURED sales value in the period versus their
// configured target, and the tier it reaches sets the per-unit rate. The
// period is one calendar month (utils/payCycle.js), so the tier starts again
// from zero every month: that is the "monthly reset".
//
// HOW the rate turns into money depends on the person's pay type
// (payTerms.service.js): fixed pays that rate per unit sold (their own set
// amount if they have one, otherwise the tier's), percentage pays a share of
// each order's value, combined pays both. Everyone starts as 'fixed' on the
// tiers, so nothing changes for anyone until an admin sets different terms.
//
// RULE 8: commission is paid only on secure money (see commission.service.js):
// a dispatched, fully paid order whose money has actually landed — not shop
// cash still in someone's pocket, not money a courier organization has
// collected but not remitted. An order counts in the period its money became
// secure. Achievement is kept in basis points (10000 = 100%) so there is no
// floating point in the tier boundaries.
function computeCommission({ staffId, storeId, periodStart, periodEnd, settings, excludeCommissioned = false, terms = null }) {
  const pay = terms || payTerms.getTerms(staffId);
  const target = parseInt(settings.commission_sales_target_kes, 10) * 100;
  const rateBelow70 = parseInt(settings.commission_below_70_percent_kes, 10) * 100;
  const rateAt70 = parseInt(settings.commission_at_70_percent_kes, 10) * 100;
  const rateAt80 = parseInt(settings.commission_at_80_percent_kes, 10) * 100;

  const secured = securedOrders({ storeId, from: periodStart, to: periodEnd, staffId, excludeCommissioned });
  const achievedSales = secured.reduce((n, o) => n + o.total, 0);
  const unitsSold = secured.reduce((n, o) => n + o.units, 0);
  const achievementBp = target > 0 ? Math.floor((achievedSales * 10000) / target) : 0;

  let tierRate;
  let tier;
  if (achievementBp >= 8000) { tierRate = rateAt80; tier = '>=80%'; }
  else if (achievementBp >= 7000) { tierRate = rateAt70; tier = '70-80%'; }
  else { tierRate = rateBelow70; tier = '<70%'; }

  const rate = payTerms.unitRateFor({ terms: pay, tierRate });
  const orders = secured.map((o) => ({ ...o, commission: payTerms.commissionForOrder({ terms: pay, tierRate, units: o.units, total: o.total }) }));

  return {
    achievedSales, target, achievementBp, achievementPercent: achievementBp / 100, unitsSold, tier, rate,
    type: pay.type, percentBp: pay.type === 'fixed' ? 0 : pay.percentBp,
    commissionTotal: orders.reduce((n, o) => n + o.commission, 0), orders,
  };
}

// One person's pay for a period, worked out from the records as they are right now. getSummary() serves it live;
// payrollRuns.service.js snapshots it into a locked run.
function calculateStaff({ staffId, storeId, periodStart, periodEnd, settings, excludeCommissioned = false }) {
  const attendance = computeAttendanceDeductions({ staffId, periodStart, periodEnd, settings });
  const commission = computeCommission({ staffId, storeId, periodStart, periodEnd, settings, excludeCommissioned });
  const retainerPerDay = parseInt(settings.daily_retainer_kes, 10) * 100;
  const dailyRetainerTotal = attendance.daysLoggedIn * retainerPerDay;

  const adjustments = db.prepare(`
    SELECT *, ${dateOf('created_at')} AS shop_date FROM payroll_adjustments
     WHERE staff_id = ? AND ${dateOf('created_at')} BETWEEN ? AND ? ORDER BY created_at, id
  `).all(staffId, periodStart, periodEnd);
  const adjustmentsTotal = adjustments.reduce((sum, a) => sum + a.amount, 0);
  const advancesTotal = adjustments.filter((a) => a.type === 'salary_advance').reduce((n, a) => n + a.amount, 0);
  const lossDeductionsTotal = adjustments.filter((a) => a.type === 'loss_deduction').reduce((n, a) => n + a.amount, 0);
  // Part of lossDeductionsTotal: commission taken back on orders that were refunded, returned or cancelled.
  const commissionReversalsTotal = adjustments.filter((a) => a.reverses_order_id).reduce((n, a) => n + a.amount, 0);

  const grossPay = dailyRetainerTotal + commission.commissionTotal;
  const totalDeductions = attendance.absenceTotal + attendance.lateTotal + attendance.missingHoursTotal + adjustmentsTotal;
  const netPayable = grossPay - totalDeductions;

  // Itemised lines: what a locked run keeps so every figure can be traced to the day, the order or the reason.
  const lines = [
    ...attendance.loggedInDates.map((d) => ({ kind: 'retainer_day', refDate: d, refText: null, quantity: null, amountCents: retainerPerDay })),
    ...commission.orders.map((o) => ({ kind: 'commission_order', refDate: o.securedDate, refText: o.orderRef, quantity: o.units, amountCents: o.commission })),
    ...attendance.breakdown.map((b) => ({
      kind: b.type, refDate: b.date, refText: null, quantity: b.hoursLate ?? b.hoursMissing ?? null, amountCents: b.amount,
    })),
    ...adjustments.map((a) => ({ kind: a.type, refDate: a.shop_date, refText: a.notes || null, quantity: null, amountCents: a.amount })),
  ];

  return {
    dailyRetainer: { daysLoggedIn: attendance.daysLoggedIn, total: dailyRetainerTotal },
    commission, attendance, adjustments, adjustmentsTotal, advancesTotal, lossDeductionsTotal,
    commissionReversalsTotal, grossPay, totalDeductions, netPayable, lines,
  };
}

function getSummary({ staffId, storeId, periodStart, periodEnd }) {
  if (!periodStart || !periodEnd) throw new ApiError(400, 'periodStart and periodEnd (YYYY-MM-DD) are required.');
  // Commission targets are per month: a summary across a month boundary would blend two targets into one tier.
  if (!sameMonth(periodStart, periodEnd)) throw new ApiError(422, 'A pay summary covers one calendar month at most: commission starts again each month.', null, 'PAYROLL_CROSSES_MONTH');
  const staff = db.prepare('SELECT id, name FROM users WHERE id = ? AND store_id = ?').get(staffId, storeId);
  if (!staff) throw new ApiError(404, 'Staff member not found.');

  const c = calculateStaff({ staffId, storeId, periodStart, periodEnd, settings: settingsService.getAll() });
  return {
    staff: { id: staff.id, name: staff.name },
    period: { start: periodStart, end: periodEnd },
    dailyRetainer: c.dailyRetainer,
    commission: c.commission,
    attendanceDeductions: {
      absenceTotal: c.attendance.absenceTotal, lateTotal: c.attendance.lateTotal, missingHoursTotal: c.attendance.missingHoursTotal,
      breakdown: c.attendance.breakdown,
    },
    adjustments: c.adjustments,
    adjustmentsTotal: c.adjustmentsTotal,
    commissionReversalsTotal: c.commissionReversalsTotal,
    grossPay: c.grossPay,
    totalDeductions: c.totalDeductions,
    netPayable: c.netPayable,
  };
}

// Standalone loss-deduction entry (§10 Loss Deductions) — the salary-
// advance path is requisitions.service.js's approve(); this is for losses
// that were never a requisition (breakage, till shortfall, etc.), entered
// directly by an admin.
function recordLossDeduction({ staffId, storeId, amount, notes, createdBy }) {
  if (!amount || amount <= 0) throw new ApiError(400, 'amount must be a positive integer (cents).');
  const result = db.prepare(`
    INSERT INTO payroll_adjustments (staff_id, store_id, type, amount, notes, created_by)
    VALUES (?, ?, 'loss_deduction', ?, ?, ?)
  `).run(staffId, storeId, amount, notes || null, createdBy);
  return db.prepare('SELECT * FROM payroll_adjustments WHERE id = ?').get(result.lastInsertRowid);
}

module.exports = { getSummary, recordLossDeduction, computeAttendanceDeductions, computeCommission, calculateStaff };
