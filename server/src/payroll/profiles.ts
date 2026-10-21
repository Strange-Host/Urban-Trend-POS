import type { Pool } from '../db/pool.js';
import type { Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { isDateString } from './time.js';

export interface CommissionPlan {
  id: number;
  name: string;
  /** Sales target for one pay period. */
  targetCents: number;
  /** Paid PER UNIT sold, by how much of the target the person reached. */
  rateBelow70Cents: number;
  rate70Cents: number;
  rate80Cents: number;
}

const nonNegInt = (v: unknown, label: string) => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new HttpError(422, 'PAY_BAD_AMOUNT', `${label} must be a whole, non-negative number of cents.`);
  return v as number;
};
const needActor = (actor: string) => { if (!actor?.trim()) throw new HttpError(422, 'PAY_NO_ACTOR', 'The person making this change is required.'); return actor.trim(); };

/** Plans are versioned: changing a rate is a NEW plan, so old payroll runs keep the plan they were calculated with. */
export async function addCommissionPlan(pool: Pool, input: {
  name: string; targetCents: number; rateBelow70Cents: number; rate70Cents: number; rate80Cents: number; actor: string;
}): Promise<CommissionPlan> {
  if (!input.name?.trim()) throw new HttpError(422, 'PLAN_NO_NAME', 'A plan needs a name.');
  if (!Number.isSafeInteger(input.targetCents) || input.targetCents <= 0) throw new HttpError(422, 'PLAN_BAD_TARGET', 'The sales target must be a positive whole number of cents.');
  const { rows } = await pool.query(
    `INSERT INTO commission_plans (name, target_cents, rate_below_70_cents, rate_70_cents, rate_80_cents, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, target_cents, rate_below_70_cents, rate_70_cents, rate_80_cents`,
    [input.name.trim(), input.targetCents, nonNegInt(input.rateBelow70Cents, 'Rate below 70%'), nonNegInt(input.rate70Cents, 'Rate at 70%'), nonNegInt(input.rate80Cents, 'Rate at 80%'), needActor(input.actor)]);
  const r = rows[0]!;
  return { id: r.id, name: r.name, targetCents: r.target_cents, rateBelow70Cents: r.rate_below_70_cents, rate70Cents: r.rate_70_cents, rate80Cents: r.rate_80_cents };
}

export interface PayProfile {
  id: number;
  staffKey: string;
  effectiveFrom: string;
  dailyRetainerCents: number;
  commissionPlan: CommissionPlan | null;
  /** Minutes after midnight, shop time. 480 = 08:00. Clocking in after this is late. */
  workdayStartMinute: number;
  /** A clocked day shorter than this incurs the missing-hours fee. */
  expectedMinutes: number;
  lateFeePerHourCents: number;
  absenceFeeCents: number;
  missingHourFeeCents: number;
}

interface ProfileRow {
  id: number; staff_key: string; effective_from: string; daily_retainer_cents: number; workday_start_minute: number; expected_minutes: number;
  late_fee_per_hour_cents: number; absence_fee_cents: number; missing_hour_fee_cents: number;
  plan_id: number | null; plan_name: string | null; target_cents: number | null; r1: number | null; r2: number | null; r3: number | null;
}
const PROFILE_SQL = `
  SELECT p.id, p.staff_key, to_char(p.effective_from, 'YYYY-MM-DD') AS effective_from, p.daily_retainer_cents, p.workday_start_minute, p.expected_minutes,
         p.late_fee_per_hour_cents, p.absence_fee_cents, p.missing_hour_fee_cents,
         c.id AS plan_id, c.name AS plan_name, c.target_cents, c.rate_below_70_cents AS r1, c.rate_70_cents AS r2, c.rate_80_cents AS r3
    FROM pay_profiles p LEFT JOIN commission_plans c ON c.id = p.commission_plan_id`;
const toProfile = (r: ProfileRow): PayProfile => ({
  id: r.id, staffKey: r.staff_key, effectiveFrom: r.effective_from, dailyRetainerCents: r.daily_retainer_cents,
  commissionPlan: r.plan_id === null ? null : { id: r.plan_id, name: r.plan_name!, targetCents: r.target_cents!, rateBelow70Cents: r.r1!, rate70Cents: r.r2!, rate80Cents: r.r3! },
  workdayStartMinute: r.workday_start_minute, expectedMinutes: r.expected_minutes, lateFeePerHourCents: r.late_fee_per_hour_cents,
  absenceFeeCents: r.absence_fee_cents, missingHourFeeCents: r.missing_hour_fee_cents,
});

/**
 * Sets how a person is paid from a date. Profiles are versioned (never edited): the one in force on the LAST day of a pay
 * period applies to the whole period. A change should therefore start on the first day of a period.
 */
export async function setPayProfile(pool: Pool, input: {
  staffKey: string; effectiveFrom: string; dailyRetainerCents: number; commissionPlanId?: number;
  workdayStartMinute?: number; expectedMinutes?: number; lateFeePerHourCents?: number; absenceFeeCents?: number; missingHourFeeCents?: number; actor: string;
}): Promise<PayProfile> {
  if (!input.staffKey?.trim()) throw new HttpError(422, 'PAY_NO_STAFF', 'Who is this pay profile for?');
  if (!isDateString(input.effectiveFrom)) throw new HttpError(422, 'PAY_BAD_DATE', 'The effective date must be YYYY-MM-DD.');
  try {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO pay_profiles (staff_key, effective_from, daily_retainer_cents, commission_plan_id, workday_start_minute, expected_minutes,
                                 late_fee_per_hour_cents, absence_fee_cents, missing_hour_fee_cents, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [input.staffKey.trim(), input.effectiveFrom, nonNegInt(input.dailyRetainerCents, 'The daily retainer'), input.commissionPlanId ?? null,
       input.workdayStartMinute ?? 480, input.expectedMinutes ?? 480, nonNegInt(input.lateFeePerHourCents ?? 0, 'The late fee'),
       nonNegInt(input.absenceFeeCents ?? 0, 'The absence fee'), nonNegInt(input.missingHourFeeCents ?? 0, 'The missing-hour fee'), needActor(input.actor)]);
    return (await profileById(pool, rows[0]!.id))!;
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505') throw new HttpError(409, 'PROFILE_EXISTS', 'That person already has a pay profile starting on that date. Profiles are never edited; use a later date.');
    if (e.code === '23503') throw new HttpError(422, 'PLAN_NOT_FOUND', 'That commission plan does not exist.');
    if (e.code === '23514') throw new HttpError(422, 'PAY_BAD_VALUE', 'A pay profile value is out of range (start time is minutes after midnight, 0 to 1439).');
    throw err;
  }
}

async function profileById(db: Queryable, id: number): Promise<PayProfile | null> {
  const { rows } = await db.query<ProfileRow>(`${PROFILE_SQL} WHERE p.id = $1`, [id]);
  return rows[0] ? toProfile(rows[0]) : null;
}

/** The profile in force for a person on a given date, or null if they were not on payroll yet. */
export async function profileFor(db: Queryable, staffKey: string, asOf: string): Promise<PayProfile | null> {
  const { rows } = await db.query<ProfileRow>(`${PROFILE_SQL} WHERE p.staff_key = $1 AND p.effective_from <= $2 ORDER BY p.effective_from DESC LIMIT 1`, [staffKey, asOf]);
  return rows[0] ? toProfile(rows[0]) : null;
}

/** Everyone on payroll as of a date (the profile in force that day), sorted by key. */
export async function profilesOnPayroll(db: Queryable, asOf: string): Promise<PayProfile[]> {
  const { rows } = await db.query<ProfileRow>(
    `${PROFILE_SQL} WHERE p.id IN (SELECT DISTINCT ON (staff_key) id FROM pay_profiles WHERE effective_from <= $1 ORDER BY staff_key, effective_from DESC) ORDER BY p.staff_key`, [asOf]);
  return rows.map(toProfile);
}

export type AdjustmentType = 'salary_advance' | 'loss_deduction' | 'bonus';

export interface Adjustment { id: number; staffKey: string; type: AdjustmentType; amountCents: number; effectiveDate: string; reason: string }

/** Throws if the date falls inside a locked (approved or paid) payroll run: that period's figures can no longer change. */
export async function assertPeriodOpen(db: Queryable, date: string): Promise<void> {
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM payroll_runs WHERE status <> 'draft' AND daterange(period_start, period_end, '[]') @> $1::date LIMIT 1`, [date]);
  if (rows[0]) throw new HttpError(409, 'PERIOD_LOCKED', `${date} falls in payroll run ${rows[0].id}, which is locked. Record it on a date in an open period.`);
}

/**
 * An advance or a loss deduction is taken off pay; a bonus is added. Always entered with a positive amount and a reason.
 * A date inside a locked payroll run is refused, because that run's figures never change.
 */
export async function recordAdjustment(pool: Pool, input: {
  staffKey: string; type: AdjustmentType; amountCents: number; effectiveDate: string; reason: string; actor: string;
}): Promise<Adjustment> {
  if (!input.staffKey?.trim()) throw new HttpError(422, 'PAY_NO_STAFF', 'Who is this adjustment for?');
  if (!['salary_advance', 'loss_deduction', 'bonus'].includes(input.type)) throw new HttpError(422, 'ADJUSTMENT_BAD_TYPE', 'The type must be salary_advance, loss_deduction or bonus.');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new HttpError(422, 'ADJUSTMENT_BAD_AMOUNT', 'The amount must be a positive whole number of cents.');
  if (!isDateString(input.effectiveDate)) throw new HttpError(422, 'PAY_BAD_DATE', 'The date must be YYYY-MM-DD.');
  if (!input.reason?.trim()) throw new HttpError(422, 'ADJUSTMENT_REASON_REQUIRED', 'A reason is required.');
  await assertPeriodOpen(pool, input.effectiveDate);
  const { rows } = await pool.query(
    `INSERT INTO payroll_adjustments (staff_key, type, amount_cents, effective_date, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, staff_key, type, amount_cents, to_char(effective_date, 'YYYY-MM-DD') AS effective_date, reason`,
    [input.staffKey.trim(), input.type, input.amountCents, input.effectiveDate, input.reason.trim(), needActor(input.actor)]);
  const r = rows[0]!;
  return { id: r.id, staffKey: r.staff_key, type: r.type, amountCents: r.amount_cents, effectiveDate: r.effective_date, reason: r.reason };
}

export async function adjustmentsFor(db: Queryable, staffKey: string, from: string, to: string): Promise<Adjustment[]> {
  const { rows } = await db.query(
    `SELECT id, staff_key, type, amount_cents, to_char(effective_date, 'YYYY-MM-DD') AS effective_date, reason FROM payroll_adjustments
      WHERE staff_key = $1 AND effective_date BETWEEN $2 AND $3 ORDER BY effective_date, id`, [staffKey, from, to]);
  return rows.map((r) => ({ id: r.id, staffKey: r.staff_key, type: r.type, amountCents: r.amount_cents, effectiveDate: r.effective_date, reason: r.reason }));
}
