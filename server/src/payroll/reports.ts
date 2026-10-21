import type { Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { computePay, previewPayroll, type PayItem, type Period } from './calculate.js';
import { profileFor } from './profiles.js';
import { getRun, totalsOf, type RunView } from './runs.js';

/** Cents to a plain decimal string, KES 1234.50 -> "1234.50". Exact integer arithmetic. */
export function kes(cents: number): string {
  const abs = Math.abs(cents);
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return cents < 0 ? `-${s}` : s;
}

export interface SalaryTable {
  period: Period;
  /** "locked" when a locked payroll run covers exactly this period (its frozen figures); otherwise "live" (calculated now). */
  source: 'locked' | 'live';
  runId: number | null;
  rows: PayItem[];
  totals: ReturnType<typeof totalsOf>;
}

async function lockedRunFor(db: Queryable, period: Period): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM payroll_runs WHERE status <> 'draft' AND period_start = $1 AND period_end = $2`, [period.from, period.to]);
  return rows[0]?.id ?? null;
}

const stripOrders = (i: PayItem & { orders?: unknown }): PayItem => { const { orders: _o, ...rest } = i as PayItem & { orders?: unknown }; return rest; };

/** Every staff member for the chosen period: days worked, retainer, commission, late, absence, missing hours, advances, loss deductions, bonuses, net pay. */
export async function salaryTable(db: Queryable, period: Period): Promise<SalaryTable> {
  const runId = await lockedRunFor(db, period);
  const rows = runId !== null ? (await getRun(db, runId))!.items : (await previewPayroll(db, period)).map(stripOrders);
  return { period, source: runId !== null ? 'locked' : 'live', runId, rows, totals: totalsOf(rows) };
}

/** One person's full breakdown for a period: the locked figures if a locked run covers it, otherwise calculated now. */
export async function staffBreakdown(db: Queryable, staffKey: string, period: Period): Promise<{ source: 'locked' | 'live'; item: PayItem }> {
  const runId = await lockedRunFor(db, period);
  if (runId !== null) {
    const item = (await getRun(db, runId))!.items.find((i) => i.staffKey === staffKey);
    if (!item) throw new HttpError(404, 'STAFF_NOT_IN_RUN', `${staffKey} is not in the locked run for this period.`);
    return { source: 'locked', item };
  }
  const profile = await profileFor(db, staffKey, period.to);
  if (!profile) throw new HttpError(404, 'STAFF_NOT_ON_PAYROLL', `${staffKey} has no pay profile for this period.`);
  return { source: 'live', item: stripOrders(await computePay(db, profile, period)) };
}

async function lockedRun(db: Queryable, runId: number): Promise<RunView> {
  const run = await getRun(db, runId);
  if (!run) throw new HttpError(404, 'RUN_NOT_FOUND', 'Payroll run not found.');
  if (run.status === 'draft') throw new HttpError(409, 'RUN_NOT_LOCKED', 'Payslips and exports come from a locked run. Approve this draft first.');
  return run;
}

export interface Payslip {
  runId: number;
  period: Period;
  status: 'approved' | 'paid';
  approvedBy: string;
  item: PayItem;
}

export async function payslip(db: Queryable, runId: number, staffKey: string): Promise<Payslip> {
  const run = await lockedRun(db, runId);
  const item = run.items.find((i) => i.staffKey === staffKey);
  if (!item) throw new HttpError(404, 'STAFF_NOT_IN_RUN', `${staffKey} is not in this payroll run.`);
  return { runId: run.id, period: { from: run.periodStart, to: run.periodEnd }, status: run.status as 'approved' | 'paid', approvedBy: run.approvedBy!, item };
}

const KIND_LABEL: Record<string, string> = {
  retainer_day: 'Daily retainer', commission_order: 'Commission', bonus: 'Bonus', late: 'Late', absence: 'Absent',
  missing_hours: 'Missing hours', salary_advance: 'Salary advance', loss_deduction: 'Loss deduction',
};

/** A plain-text payslip. Everything on it comes from the locked run, so reprinting it later gives the same page. */
export function renderPayslip(p: Payslip): string {
  const i = p.item;
  const row = (label: string, cents: number, sign = '') => `${label.padEnd(34)}${(sign + kes(cents)).padStart(14)}`;
  const out = [
    'PAYSLIP', `Staff:   ${i.staffKey}`, `Period:  ${p.period.from} to ${p.period.to}`, `Run:     #${p.runId} (${p.status}, approved by ${p.approvedBy})`, '',
    'EARNINGS',
    row(`Daily retainer (${i.daysWorked} days)`, i.retainerCents),
    row(`Commission (${i.unitsSold} units${i.tier ? `, tier ${i.tier}` : ''})`, i.commissionCents),
    row('Bonuses', i.bonusesCents),
    row('Gross pay', i.grossCents), '',
    'DEDUCTIONS',
    row('Late', i.lateCents, '-'), row('Absence', i.absenceCents, '-'), row('Missing hours', i.missingHoursCents, '-'),
    row('Salary advances', i.advancesCents, '-'), row('Loss deductions', i.lossDeductionsCents, '-'),
    row('Total deductions', i.deductionsCents, '-'), '',
    row('NET PAY', i.netCents),
  ];
  if (i.shortfallCents > 0) out.push(row('Owed back (deductions exceed earnings)', i.shortfallCents), 'Nothing is payable this period.');
  out.push('', 'DETAIL');
  for (const l of i.lines) {
    const what = l.kind === 'commission_order' ? `Order ${l.refText}, ${l.quantity} unit(s)` : l.quantity !== null ? `${l.quantity} hour(s)` : (l.refText ?? '');
    out.push(`${(l.refDate ?? '').padEnd(12)}${(KIND_LABEL[l.kind] ?? l.kind).padEnd(18)}${what.padEnd(28)}${kes(l.amountCents).padStart(10)}`);
  }
  return out.join('\n');
}

// Staff names end up in a spreadsheet, and a cell that starts with = + - @ can run as a formula there. Text cells that start
// with one of those get a leading apostrophe so they are shown, never executed.
const text = (v: string) => {
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const CSV_HEADER = ['staff', 'days_worked', 'retainer', 'units_sold', 'commission', 'bonuses', 'gross', 'late', 'absence', 'missing_hours', 'advances', 'loss_deductions', 'deductions', 'net', 'payable', 'owed_back'];

/** The whole run as CSV (amounts in KES). Only from a locked run, so an export can always be reproduced exactly. */
export async function exportRunCsv(db: Queryable, runId: number): Promise<string> {
  const run = await lockedRun(db, runId);
  const lines = [CSV_HEADER.join(',')];
  for (const i of run.items) {
    lines.push([text(i.staffKey), i.daysWorked, kes(i.retainerCents), i.unitsSold, kes(i.commissionCents), kes(i.bonusesCents), kes(i.grossCents), kes(i.lateCents),
      kes(i.absenceCents), kes(i.missingHoursCents), kes(i.advancesCents), kes(i.lossDeductionsCents), kes(i.deductionsCents), kes(i.netCents), kes(i.payableCents), kes(i.shortfallCents)].join(','));
  }
  const t = run.totals;
  lines.push(['TOTAL', '', '', '', kes(t.commissionCents), '', kes(t.grossCents), '', '', '', '', '', kes(t.deductionsCents), kes(t.netCents), kes(t.payableCents), kes(t.shortfallCents)].join(','));
  return `${lines.join('\r\n')}\r\n`;
}
