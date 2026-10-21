import type { Queryable } from '../db/tx.js';
import { attendanceFor, type AttendanceRecord } from './attendance.js';
import { securedOrders, type SecuredOrder } from './commission.js';
import { adjustmentsFor, profilesOnPayroll, type PayProfile } from './profiles.js';
import { ceilDiv, shopDate, shopDayEnd, shopDayStart, shopSecondsOfDay } from './time.js';

// The payroll calculation. The formulas are the existing system's, made exact (whole seconds and integer arithmetic,
// no floating point):
//   retainer     a fixed amount for every day the person clocked in
//   late         clocking in after the start time: every hour or part of an hour late is charged
//   absence      a day recorded as absent costs the absence fee (an absent day is never also late or short)
//   missing hrs  a clocked day shorter than the expected length: every hour or part of an hour short is charged
//   commission   PER UNIT sold, at a rate set by how much of the period's target was reached (<70%, 70-80%, 80%+), counting
//                only orders whose money is fully SECURE (Rule 8, see commission.ts)
//   bonus        added;  advance and loss deduction: taken off
//   net          earnings minus deductions. If deductions exceed earnings the person is paid nothing and the shortfall is shown.

export type LineKind = 'retainer_day' | 'commission_order' | 'bonus' | 'late' | 'absence' | 'missing_hours' | 'salary_advance' | 'loss_deduction';

export interface PayLine {
  kind: LineKind;
  refDate: string | null;
  refText: string | null;
  quantity: number | null;
  amountCents: number;
}

export type Tier = '<70%' | '70-80%' | '>=80%';

export interface PayItem {
  staffKey: string;
  daysWorked: number;
  retainerCents: number;
  unitsSold: number;
  achievedSalesCents: number;
  targetCents: number;
  /** Achievement in basis points (10000 = 100%). */
  achievementBp: number;
  tier: Tier | null;
  rateCents: number;
  commissionCents: number;
  bonusesCents: number;
  lateCents: number;
  absenceCents: number;
  missingHoursCents: number;
  advancesCents: number;
  lossDeductionsCents: number;
  grossCents: number;
  deductionsCents: number;
  netCents: number;
  payableCents: number;
  shortfallCents: number;
  lines: PayLine[];
}

export interface PayItemWithOrders extends PayItem { orders: SecuredOrder[] }

export interface Period { from: string; to: string }

export function attendanceDeductions(records: AttendanceRecord[], profile: PayProfile) {
  const lines: PayLine[] = [];
  let daysWorked = 0, late = 0, absence = 0, missing = 0;
  const startSec = profile.workdayStartMinute * 60;
  const expectedSec = profile.expectedMinutes * 60;
  for (const r of records) {
    if (!r.clockInAt) {
      absence += profile.absenceFeeCents;
      lines.push({ kind: 'absence', refDate: r.workDate, refText: r.absenceReason, quantity: null, amountCents: profile.absenceFeeCents });
      continue;
    }
    daysWorked += 1;
    const inSec = shopSecondsOfDay(r.clockInAt);
    if (inSec > startSec) {
      const hoursLate = ceilDiv(inSec - startSec, 3600);
      const fee = hoursLate * profile.lateFeePerHourCents;
      late += fee;
      lines.push({ kind: 'late', refDate: r.workDate, refText: null, quantity: hoursLate, amountCents: fee });
    }
    if (r.clockOutAt) {
      const workedSec = Math.round((r.clockOutAt.getTime() - r.clockInAt.getTime()) / 1000);
      if (workedSec < expectedSec) {
        const hoursMissing = ceilDiv(expectedSec - workedSec, 3600);
        const fee = hoursMissing * profile.missingHourFeeCents;
        missing += fee;
        lines.push({ kind: 'missing_hours', refDate: r.workDate, refText: null, quantity: hoursMissing, amountCents: fee });
      }
    }
  }
  return { daysWorked, late, absence, missing, lines };
}

export function tierFor(achievementBp: number): Tier {
  return achievementBp >= 8000 ? '>=80%' : achievementBp >= 7000 ? '70-80%' : '<70%';
}

export async function computePay(db: Queryable, profile: PayProfile, period: Period): Promise<PayItemWithOrders> {
  const records = await attendanceFor(db, profile.staffKey, period.from, period.to);
  const att = attendanceDeductions(records, profile);
  const lines: PayLine[] = [];

  const retainer = att.daysWorked * profile.dailyRetainerCents;
  for (const r of records.filter((x) => x.clockInAt)) {
    lines.push({ kind: 'retainer_day', refDate: r.workDate, refText: null, quantity: null, amountCents: profile.dailyRetainerCents });
  }

  // Commission: only fully secure orders, counted on the day they became secure.
  const plan = profile.commissionPlan;
  const orders = plan ? await securedOrders(db, { staffKey: profile.staffKey, from: shopDayStart(period.from), to: shopDayEnd(period.to) }) : [];
  const achieved = orders.reduce((s, o) => s + o.totalCents, 0);
  const units = orders.reduce((s, o) => s + o.units, 0);
  const target = plan?.targetCents ?? 0;
  const bp = target > 0 ? Number((BigInt(achieved) * 10_000n) / BigInt(target)) : 0; // BigInt: achieved x 10,000 can pass 2^53
  const tier = plan ? tierFor(bp) : null;
  const rate = !plan ? 0 : tier === '>=80%' ? plan.rate80Cents : tier === '70-80%' ? plan.rate70Cents : plan.rateBelow70Cents;
  const commission = units * rate;
  for (const o of orders) {
    lines.push({ kind: 'commission_order', refDate: shopDate(o.securedAt), refText: o.orderRef, quantity: o.units, amountCents: o.units * rate });
  }

  const adjustments = await adjustmentsFor(db, profile.staffKey, period.from, period.to);
  const sum = (t: string) => adjustments.filter((a) => a.type === t).reduce((s, a) => s + a.amountCents, 0);
  for (const a of adjustments) {
    lines.push({ kind: a.type, refDate: a.effectiveDate, refText: a.reason, quantity: null, amountCents: a.amountCents });
  }
  const bonuses = sum('bonus'), advances = sum('salary_advance'), losses = sum('loss_deduction');

  lines.push(...att.lines);
  const gross = retainer + commission + bonuses;
  const deductions = att.late + att.absence + att.missing + advances + losses;
  const net = gross - deductions;
  return {
    staffKey: profile.staffKey, daysWorked: att.daysWorked, retainerCents: retainer, unitsSold: units, achievedSalesCents: achieved, targetCents: target,
    achievementBp: bp, tier, rateCents: rate, commissionCents: commission, bonusesCents: bonuses, lateCents: att.late, absenceCents: att.absence,
    missingHoursCents: att.missing, advancesCents: advances, lossDeductionsCents: losses, grossCents: gross, deductionsCents: deductions, netCents: net,
    payableCents: Math.max(net, 0), shortfallCents: Math.max(-net, 0), lines, orders,
  };
}

/** Everyone on payroll (their profile in force on the period's last day), calculated live. Writes nothing. */
export async function previewPayroll(db: Queryable, period: Period): Promise<PayItemWithOrders[]> {
  const profiles = await profilesOnPayroll(db, period.to);
  const items: PayItemWithOrders[] = [];
  for (const p of profiles) items.push(await computePay(db, p, period));
  return items;
}
