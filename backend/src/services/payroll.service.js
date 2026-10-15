const db = require('../config/db');
const { dateOf, sqlOffset } = require('../utils/storeTime');
const ApiError = require('../utils/ApiError');
const settingsService = require('./settings.service');

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

  return { daysLoggedIn, absenceTotal, lateTotal, missingHoursTotal, breakdown };
}

// §6 Commission tiers — see settings.service.js DEFAULTS for the "best
// guess pending confirmation" caveat on the actual numbers. Achievement is
// this staff member's dispatched-and-paid sales value in the period versus
// their configured target; the rate that tier earns is then paid PER UNIT
// (order_item quantity) they actually sold — not a flat percentage of
// revenue. Only counts orders that reached dispatched_paid — commission on
// money that was never actually collected isn't commission, it's a
// projection.
function computeCommission({ staffId, periodStart, periodEnd, settings }) {
  const target = parseInt(settings.commission_sales_target_kes, 10) * 100;
  const rateBelow70 = parseInt(settings.commission_below_70_percent_kes, 10) * 100;
  const rateAt70 = parseInt(settings.commission_at_70_percent_kes, 10) * 100;
  const rateAt80 = parseInt(settings.commission_at_80_percent_kes, 10) * 100;

  const salesRow = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS achieved
    FROM orders
    WHERE assigned_staff_id = ? AND status = 'dispatched_paid'
      AND ${dateOf('dispatched_at')} BETWEEN ? AND ? AND deleted_at IS NULL
  `).get(staffId, periodStart, periodEnd);
  const achievedSales = salesRow.achieved;
  const achievementPercent = target > 0 ? (achievedSales / target) * 100 : 0;

  const unitsRow = db.prepare(`
    SELECT COALESCE(SUM(oi.quantity), 0) AS units
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.assigned_staff_id = ? AND o.status = 'dispatched_paid'
      AND ${dateOf('o.dispatched_at')} BETWEEN ? AND ? AND o.deleted_at IS NULL
  `).get(staffId, periodStart, periodEnd);
  const unitsSold = unitsRow.units;

  let rate;
  let tier;
  if (achievementPercent >= 80) { rate = rateAt80; tier = '>=80%'; }
  else if (achievementPercent >= 70) { rate = rateAt70; tier = '70-80%'; }
  else { rate = rateBelow70; tier = '<70%'; }

  return { achievedSales, target, achievementPercent, unitsSold, tier, rate, commissionTotal: unitsSold * rate };
}

function getSummary({ staffId, storeId, periodStart, periodEnd }) {
  if (!periodStart || !periodEnd) throw new ApiError(400, 'periodStart and periodEnd (YYYY-MM-DD) are required.');
  const staff = db.prepare('SELECT id, name FROM users WHERE id = ? AND store_id = ?').get(staffId, storeId);
  if (!staff) throw new ApiError(404, 'Staff member not found.');

  const settings = settingsService.getAll();
  const attendance = computeAttendanceDeductions({ staffId, periodStart, periodEnd, settings });
  const commission = computeCommission({ staffId, periodStart, periodEnd, settings });
  const dailyRetainerTotal = attendance.daysLoggedIn * parseInt(settings.daily_retainer_kes, 10) * 100;

  const adjustments = db.prepare(`
    SELECT * FROM payroll_adjustments WHERE staff_id = ? AND ${dateOf('created_at')} BETWEEN ? AND ? ORDER BY created_at
  `).all(staffId, periodStart, periodEnd);
  const adjustmentsTotal = adjustments.reduce((sum, a) => sum + a.amount, 0);

  const grossPay = dailyRetainerTotal + commission.commissionTotal;
  const totalDeductions = attendance.absenceTotal + attendance.lateTotal + attendance.missingHoursTotal + adjustmentsTotal;
  const netPayable = grossPay - totalDeductions;

  return {
    staff: { id: staff.id, name: staff.name },
    period: { start: periodStart, end: periodEnd },
    dailyRetainer: { daysLoggedIn: attendance.daysLoggedIn, total: dailyRetainerTotal },
    commission,
    attendanceDeductions: {
      absenceTotal: attendance.absenceTotal, lateTotal: attendance.lateTotal, missingHoursTotal: attendance.missingHoursTotal,
      breakdown: attendance.breakdown,
    },
    adjustments,
    adjustmentsTotal,
    grossPay,
    totalDeductions,
    netPayable,
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

module.exports = { getSummary, recordLossDeduction, computeAttendanceDeductions, computeCommission };
