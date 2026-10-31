const crypto = require('crypto');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const settingsService = require('./settings.service');
const { sqlOffset, localDate } = require('../utils/storeTime');
const { securedOrders } = require('./commission.service');
const { calculateStaff } = require('./payroll.service');
const { sweepReversals } = require('./commissionReversal.service');
const { requireSignature } = require('../utils/signature');
const { isRealDate, isMonth, monthBounds, sameMonth, payDateFor, normalizePayDay, cycleAround } = require('../utils/payCycle');

// Locked payroll runs. Ported from the update branch's payroll/runs.ts (Rule 9: a locked run never changes).
//
// A run covers one period for everyone on payroll.
//   draft     calculated and saved as a snapshot; can be regenerated as often as you like
//   approved  LOCKED: the figures are frozen, fingerprinted, and every order commissioned is recorded so none
//             can ever earn commission twice
//   paid      LOCKED and paid
// The database enforces the lock with triggers (see schema.sql), so it holds even if code elsewhere forgets it.
// Approval and payment are admin-only actions (routes). All amounts are integer cents; periods are shop dates.

const runError = (status, code, message) => new ApiError(status, message, null, code);

// The pay cycle (utils/payCycle.js): a period is inside ONE calendar month and is paid on a fixed day of the next
// (settings payroll_pay_day, the 3rd). Commission targets are per month, so a period that straddled two would
// blend two targets into one tier.
function checkPeriod(from, to) {
  if (!isRealDate(from) || !isRealDate(to) || to < from) {
    throw runError(422, 'PAYROLL_BAD_PERIOD', 'A pay period needs a start and an end date (YYYY-MM-DD), end not before start.');
  }
  if (!sameMonth(from, to)) {
    throw runError(422, 'PAYROLL_CROSSES_MONTH', 'A pay period is one calendar month at most: commission starts again each month. Run each month separately.');
  }
}

const payDayNow = () => normalizePayDay(settingsService.getAll().payroll_pay_day);

// ---------------------------------------------------------------- calculating a period

/** Everyone on payroll for the period, calculated from the records as they are right now. Saves nothing. */
function previewPayroll({ storeId, from, to }) {
  const settings = settingsService.getAll();
  // On payroll = clocked in or marked absent, earned commission on secured money, or has a deduction in the period.
  const staffIds = new Set([
    ...db.prepare('SELECT DISTINCT staff_id FROM staff_attendance WHERE store_id = ? AND work_date BETWEEN ? AND ?').all(storeId, from, to).map((r) => r.staff_id),
    ...securedOrders({ storeId, from, to }).map((o) => o.staffId),
    ...db.prepare(`SELECT DISTINCT staff_id FROM payroll_adjustments WHERE store_id = ? AND date(created_at, ${sqlOffset()}) BETWEEN ? AND ?`)
      .all(storeId, from, to).map((r) => r.staff_id),
  ]);
  const users = db.prepare('SELECT id, name FROM users WHERE store_id = ?').all(storeId);
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  return [...staffIds].filter((id) => nameOf.has(id)).sort((a, b) => a - b).map((staffId) => {
    // Orders already commissioned in a locked run never earn again (a re-secured order must not be paid twice).
    const c = calculateStaff({ staffId, storeId, periodStart: from, periodEnd: to, settings, excludeCommissioned: true });
    const net = c.netPayable;
    return {
      staffId, staffName: nameOf.get(staffId),
      daysWorked: c.dailyRetainer.daysLoggedIn, retainer: c.dailyRetainer.total,
      unitsSold: c.commission.unitsSold, achievedSales: c.commission.achievedSales, target: c.commission.target,
      achievementBp: c.commission.achievementBp, tier: c.commission.tier, rate: c.commission.rate, commission: c.commission.commissionTotal,
      commissionType: c.commission.type, percentBp: c.commission.percentBp,
      late: c.attendance.lateTotal, absence: c.attendance.absenceTotal, missingHours: c.attendance.missingHoursTotal,
      advances: c.advancesTotal, lossDeductions: c.lossDeductionsTotal,
      gross: c.grossPay, deductions: c.totalDeductions, net, payable: Math.max(net, 0), shortfall: Math.max(-net, 0),
      lines: c.lines, orders: c.commission.orders,
    };
  });
}

// ---------------------------------------------------------------- fingerprint

const MONEY_KEYS = ['daysWorked', 'retainer', 'unitsSold', 'achievedSales', 'target', 'achievementBp', 'tier', 'rate', 'commission',
  'late', 'absence', 'missingHours', 'advances', 'lossDeductions', 'gross', 'deductions', 'net', 'payable', 'shortfall'];

/** A stable text form of a run's figures: used to compare a draft with a fresh calculation and to fingerprint a locked run. */
function canonicalItems(period, items) {
  // The pay type is part of the fingerprint only when it is not the plain per-unit kind. Every run approved before pay
  // types existed was 'fixed', and leaving it out for them keeps their recorded checksums verifying exactly as before.
  const rows = [...items].sort((a, b) => a.staffId - b.staffId).map((i) => {
    const row = [
      i.staffId, ...MONEY_KEYS.map((k) => i[k]),
      i.lines.map((l) => [l.kind, l.refDate ?? null, l.refText ?? null, l.quantity ?? null, l.amountCents]),
    ];
    if (i.commissionType && i.commissionType !== 'fixed') row.push(['pay', i.commissionType, i.percentBp]);
    return row;
  });
  return JSON.stringify({ period: [period.from, period.to], items: rows });
}

const fingerprint = (canonical) => crypto.createHash('sha256').update(canonical).digest('hex');

// ---------------------------------------------------------------- reading runs

function loadItems(runId) {
  const items = db.prepare('SELECT * FROM payroll_items WHERE run_id = ? ORDER BY staff_id').all(runId);
  const lines = db.prepare(`
    SELECT l.* FROM payroll_item_lines l JOIN payroll_items i ON i.id = l.item_id WHERE i.run_id = ? ORDER BY l.id
  `).all(runId);
  return items.map((r) => ({
    staffId: r.staff_id, staffName: r.staff_name, daysWorked: r.days_worked, retainer: r.retainer, unitsSold: r.units_sold,
    achievedSales: r.achieved_sales, target: r.target, achievementBp: r.achievement_bp, tier: r.tier, rate: r.rate, commission: r.commission,
    commissionType: r.commission_type, percentBp: r.percent_bp,
    late: r.late, absence: r.absence, missingHours: r.missing_hours, advances: r.advances, lossDeductions: r.loss_deductions,
    gross: r.gross, deductions: r.deductions, net: r.net, payable: r.payable, shortfall: r.shortfall,
    lines: lines.filter((l) => l.item_id === r.id).map((l) => ({ kind: l.kind, refDate: l.ref_date, refText: l.ref_text, quantity: l.quantity, amountCents: l.amount })),
  }));
}

const sumOf = (items, k) => items.reduce((n, i) => n + i[k], 0);
const totalsOf = (items) => ({
  gross: sumOf(items, 'gross'), deductions: sumOf(items, 'deductions'), net: sumOf(items, 'net'),
  payable: sumOf(items, 'payable'), shortfall: sumOf(items, 'shortfall'), commission: sumOf(items, 'commission'),
});

const RUN_SELECT = `SELECT r.*, (SELECT name FROM users WHERE id = r.created_by) AS created_by_name,
  (SELECT name FROM users WHERE id = r.approved_by) AS approved_by_name, (SELECT name FROM users WHERE id = r.paid_by) AS paid_by_name,
  (SELECT name FROM users WHERE id = r.signed_off_by) AS signed_off_by_name FROM payroll_runs r`;

const viewOf = (r) => ({
  createdByName: r.created_by_name, approvedByName: r.approved_by_name, paidByName: r.paid_by_name,
  id: r.id, periodStart: r.period_start, periodEnd: r.period_end, status: r.status, createdBy: r.created_by, createdAt: r.created_at,
  approvedBy: r.approved_by, approvedAt: r.approved_at, paidBy: r.paid_by, paidAt: r.paid_at,
  paymentMethod: r.payment_method, paymentRef: r.payment_ref, checksum: r.checksum,
  payDate: r.pay_date, signedOffBy: r.signed_off_by, signedOffByName: r.signed_off_by_name, signedOffAt: r.signed_off_at, signedOffName: r.signed_off_name,
});

function getRun({ runId, storeId }) {
  const r = db.prepare(`${RUN_SELECT} WHERE r.id = ? AND r.store_id = ?`).get(runId, storeId);
  if (!r) throw runError(404, 'RUN_NOT_FOUND', 'Payroll run not found.');
  const items = loadItems(r.id);
  return { ...viewOf(r), items, totals: totalsOf(items) };
}

function listRuns({ storeId }) {
  return db.prepare(`${RUN_SELECT} WHERE r.store_id = ? ORDER BY r.period_start DESC, r.id DESC`).all(storeId).map(viewOf);
}

/**
 * Re-checks a locked run: the figures stored now must hash to the fingerprint recorded at approval.
 * A mismatch means the run was changed behind the application's back.
 */
function verifyRun({ runId, storeId }) {
  const r = db.prepare('SELECT * FROM payroll_runs WHERE id = ? AND store_id = ?').get(runId, storeId);
  if (!r) throw runError(404, 'RUN_NOT_FOUND', 'Payroll run not found.');
  if (r.status === 'draft') return { runId: r.id, status: r.status, locked: false, intact: null, checksum: null, recomputed: null };
  const recomputed = fingerprint(canonicalItems({ from: r.period_start, to: r.period_end }, loadItems(r.id)));
  return { runId: r.id, status: r.status, locked: true, intact: recomputed === r.checksum, checksum: r.checksum, recomputed };
}

// ---------------------------------------------------------------- draft -> approved -> paid

const insertItem = () => db.prepare(`
  INSERT INTO payroll_items (run_id, staff_id, staff_name, days_worked, retainer, units_sold, achieved_sales, target, achievement_bp, tier, rate,
                             commission, commission_type, percent_bp, late, absence, missing_hours, advances, loss_deductions, gross, deductions, net, payable, shortfall)
  VALUES (@runId, @staffId, @staffName, @daysWorked, @retainer, @unitsSold, @achievedSales, @target, @achievementBp, @tier, @rate,
          @commission, @commissionType, @percentBp, @late, @absence, @missingHours, @advances, @lossDeductions, @gross, @deductions, @net, @payable, @shortfall)
`);
const insertLine = () => db.prepare('INSERT INTO payroll_item_lines (item_id, kind, ref_date, ref_text, quantity, amount) VALUES (?, ?, ?, ?, ?, ?)');

const overlappingLocked = (storeId, from, to) => db.prepare(`
  SELECT id FROM payroll_runs WHERE store_id = ? AND status <> 'draft' AND period_start <= ? AND period_end >= ? LIMIT 1
`).get(storeId, to, from);

/**
 * Calculates the period and saves it as a draft. Running it again for the same period replaces the draft with a fresh
 * calculation. Pass `month` ('YYYY-MM') for a whole calendar month, or `from`/`to` for part of one.
 */
function generateDraft({ storeId, month, from, to, staffId }) {
  if (month !== undefined && month !== null && month !== '') {
    if (!isMonth(month)) throw runError(422, 'PAYROLL_BAD_PERIOD', 'month must look like 2026-10.');
    ({ from, to } = monthBounds(month));
  }
  checkPeriod(from, to);
  if (!staffId) throw runError(422, 'PAY_NO_ACTOR', 'The person generating payroll is required.');

  return db.transaction(() => {
    const locked = overlappingLocked(storeId, from, to);
    if (locked) throw runError(409, 'PERIOD_LOCKED', `That period overlaps payroll run ${locked.id}, which is locked.`);

    // Take back commission on any already-commissioned order whose sale has since fallen through, before calculating.
    sweepReversals({ storeId, actorId: staffId });

    const existing = db.prepare(`SELECT id FROM payroll_runs WHERE store_id = ? AND status = 'draft' AND period_start = ? AND period_end = ?`).get(storeId, from, to);
    let runId;
    if (existing) {
      runId = existing.id;
      db.prepare('DELETE FROM payroll_item_lines WHERE item_id IN (SELECT id FROM payroll_items WHERE run_id = ?)').run(runId);
      db.prepare('DELETE FROM payroll_items WHERE run_id = ?').run(runId);
    } else {
      runId = db.prepare('INSERT INTO payroll_runs (store_id, period_start, period_end, created_by, pay_date) VALUES (?, ?, ?, ?, ?)')
        .run(storeId, from, to, staffId, payDateFor(to, payDayNow())).lastInsertRowid;
    }

    const addItem = insertItem();
    const addLine = insertLine();
    for (const i of previewPayroll({ storeId, from, to })) {
      const itemId = addItem.run({ runId, ...i }).lastInsertRowid;
      for (const l of i.lines) addLine.run(itemId, l.kind, l.refDate, l.refText, l.quantity, l.amountCents);
    }
    logStaffAction({ staffId, action: 'create', entityType: 'payroll_run', entityId: runId, after: { period_start: from, period_end: to, status: 'draft' } });
    return getRun({ runId, storeId });
  }).immediate();
}

/**
 * Approves a draft, which LOCKS it. The period is recalculated first and must match what is saved: if anything has
 * changed since the draft was generated (a payment secured, a deduction added), approval is refused so what is frozen
 * is exactly what is true now and what was reviewed. Every order commissioned in the run is recorded, so none can
 * ever earn commission twice.
 */
function approveRun({ runId, storeId, staffId }) {
  if (!staffId) throw runError(422, 'PAY_NO_ACTOR', 'The approver is required.');

  return db.transaction(() => {
    const run = db.prepare('SELECT * FROM payroll_runs WHERE id = ? AND store_id = ?').get(runId, storeId);
    if (!run) throw runError(404, 'RUN_NOT_FOUND', 'Payroll run not found.');
    if (run.status !== 'draft') throw runError(409, 'RUN_NOT_DRAFT', `This run is already ${run.status}.`);

    const period = { from: run.period_start, to: run.period_end };
    const stored = loadItems(run.id);
    const fresh = previewPayroll({ storeId, ...period });
    if (fresh.length === 0) throw runError(409, 'RUN_EMPTY', 'Nobody is on payroll for this period, so there is nothing to approve.');
    if (canonicalItems(period, stored) !== canonicalItems(period, fresh)) {
      throw runError(409, 'RUN_STALE', 'Something has changed since this draft was generated. Generate it again, review it, then approve.');
    }

    const addOrder = db.prepare('INSERT INTO commissioned_orders (order_id, run_id, staff_id, units, total, secured_at, commission) VALUES (?, ?, ?, ?, ?, ?, ?)');
    try {
      for (const i of fresh) for (const o of i.orders) addOrder.run(o.orderId, run.id, i.staffId, o.units, o.total, o.securedAt, o.commission);
    } catch (err) {
      if (/commissioned_orders\.order_id|UNIQUE constraint/.test(err.message)) {
        throw runError(409, 'COMMISSION_ALREADY_PAID', 'An order in this run has already earned commission in another payroll run.');
      }
      throw err;
    }

    const checksum = fingerprint(canonicalItems(period, stored));
    try {
      // pay_date is recomputed here: a draft row cannot be edited, but approval may set it, and the pay day setting
      // may have been changed since the draft was generated.
      db.prepare(`UPDATE payroll_runs SET status = 'approved', approved_by = ?, approved_at = datetime('now'), checksum = ?, pay_date = ? WHERE id = ?`)
        .run(staffId, checksum, payDateFor(run.period_end, payDayNow()), run.id);
    } catch (err) {
      if (/PERIOD_LOCKED/.test(err.message)) throw runError(409, 'PERIOD_LOCKED', 'Another locked payroll run already covers part of this period.');
      throw err;
    }
    logStaffAction({ staffId, action: 'update', entityType: 'payroll_run', entityId: run.id, before: { status: 'draft' }, after: { status: 'approved', checksum } });
    return getRun({ runId: run.id, storeId });
  }).immediate();
}

/**
 * Records that an approved run has been paid, with the sign-off of the person releasing the money.
 *
 * Sign-off is two things the payer must give, on top of being an admin: their own full name typed as a signature
 * (checked against their account) and the run's checksum - the fingerprint of the exact figures, which the screen
 * shows beside the totals - so what they signed is provably what was approved. The run is re-verified first: a run
 * whose stored figures no longer match its checksum is never paid. The run stays exactly as approved.
 *
 * Paying before the pay date is allowed (an advance of a day or two happens) and is simply visible: pay_date and
 * paid_at are both on the record.
 */
function markRunPaid({ runId, storeId, staffId, method, paymentRef, signedName, checksum }) {
  if (!staffId) throw runError(422, 'PAY_NO_ACTOR', 'The person paying is required.');
  if (!['mpesa', 'bank', 'cash'].includes(method)) throw runError(422, 'PAYOUT_BAD_METHOD', 'Pay by mpesa, bank or cash.');
  const ref = typeof paymentRef === 'string' ? paymentRef.trim() : '';
  if (method !== 'cash' && !ref) throw runError(422, 'PAYOUT_REFERENCE_REQUIRED', 'Enter the payment reference.');

  return db.transaction(() => {
    const run = db.prepare('SELECT status, checksum FROM payroll_runs WHERE id = ? AND store_id = ?').get(runId, storeId);
    if (!run) throw runError(404, 'RUN_NOT_FOUND', 'Payroll run not found.');
    if (run.status !== 'approved') {
      throw runError(409, 'RUN_NOT_APPROVED', run.status === 'paid' ? 'This run has already been paid.' : 'Only an approved run can be paid.');
    }

    const payer = db.prepare('SELECT name FROM users WHERE id = ?').get(staffId);
    const signature = requireSignature(signedName, payer ? payer.name : '', 'this payout');
    if (!checksum || checksum !== run.checksum) {
      throw runError(422, 'PAYOUT_CHECKSUM_MISMATCH', 'Sign-off needs the run checksum shown with the totals, so what you sign is exactly what was approved.');
    }
    if (!verifyRun({ runId, storeId }).intact) {
      throw runError(409, 'RUN_TAMPERED', 'This run no longer matches the fingerprint recorded when it was approved, so it will not be paid. Investigate before releasing any money.');
    }

    db.prepare(`UPDATE payroll_runs SET status = 'paid', paid_by = ?, paid_at = datetime('now'), payment_method = ?, payment_ref = ?,
                                       signed_off_by = ?, signed_off_at = datetime('now'), signed_off_name = ? WHERE id = ?`)
      .run(staffId, method, ref || null, staffId, signature, runId);
    logStaffAction({ staffId, action: 'update', entityType: 'payroll_run', entityId: runId, before: { status: 'approved' }, after: { status: 'paid', payment_method: method, signed_off_name: signature } });
    return getRun({ runId, storeId });
  }).immediate();
}

/**
 * Where the pay cycle stands today: the month being worked, and the month just finished with whether its pay has been
 * calculated, approved and paid and whether the fixed pay date has arrived (or passed with the money not yet out).
 */
function cycleStatus({ storeId }) {
  const today = localDate();
  const payDay = payDayNow();
  const { current, previous } = cycleAround(today, payDay);
  const runFor = (c) => db.prepare(`
    SELECT id, status, pay_date FROM payroll_runs WHERE store_id = ? AND period_start = ? AND period_end = ?
     ORDER BY CASE status WHEN 'paid' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, id DESC LIMIT 1
  `).get(storeId, c.from, c.to) || null;
  const prevRun = runFor(previous);
  const paid = prevRun && prevRun.status === 'paid';
  return {
    today, payDay,
    current: { ...current, run: runFor(current) },
    previous: { ...previous, run: prevRun, payDue: today >= previous.payDate, overdue: today > previous.payDate && !paid },
  };
}

module.exports = {
  previewPayroll, canonicalItems, fingerprint, totalsOf, getRun, listRuns, verifyRun, generateDraft, approveRun, markRunPaid, cycleStatus,
};
