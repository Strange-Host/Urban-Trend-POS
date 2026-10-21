import type { Pool } from '../db/pool.js';
import type { Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { shopDate } from '../payroll/time.js';
import { audit } from './audit.js';

// Discount limits by role, and who may approve what. Roles are passed in by the caller (the login system of a later phase
// supplies them); what each role is allowed to do lives in the policy table and is versioned, never edited.

export interface DiscountPolicy {
  role: string;
  /** The most this role may discount, as a share of the sale's value, WITHOUT approval (basis points). */
  freeLimitBp: number;
  /** The most this role may APPROVE for someone else. 0 means the role cannot approve anything. */
  approveCeilingBp: number;
}

export async function policyFor(db: Queryable, role: string, asOf: string = shopDate(new Date())): Promise<DiscountPolicy> {
  const { rows } = await db.query<{ free: number; ceil: number }>(
    `SELECT free_limit_bp AS free, approve_ceiling_bp AS ceil FROM discount_policies WHERE role = $1 AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1`, [role, asOf]);
  if (!rows[0]) throw new HttpError(422, 'UNKNOWN_ROLE', `"${role}" is not a known role. Known roles have a discount policy.`);
  return { role, freeLimitBp: rows[0].free, approveCeilingBp: rows[0].ceil };
}

/** A new policy for a role from a date. Policies are never edited. */
export async function setDiscountPolicy(pool: Pool, input: { role: string; freeLimitBp: number; approveCeilingBp: number; effectiveFrom: string; actor: string }): Promise<DiscountPolicy> {
  if (!input.actor?.trim()) throw new HttpError(422, 'POLICY_NO_ACTOR', 'The person changing the policy is required.');
  try {
    await pool.query(`INSERT INTO discount_policies (role, free_limit_bp, approve_ceiling_bp, effective_from, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [input.role, input.freeLimitBp, input.approveCeilingBp, input.effectiveFrom, input.actor.trim()]);
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23505') throw new HttpError(409, 'POLICY_EXISTS', 'That role already has a policy starting on that date. Policies are never edited; use a later date.');
    if (e.code === '23514' || e.code === '22007' || e.code === '22P02') throw new HttpError(422, 'POLICY_INVALID', 'Limits are 0 to 10000 basis points, an approver\'s ceiling cannot be below its free limit, and the date must be YYYY-MM-DD.');
    throw err;
  }
  await audit(pool, { actor: input.actor, action: 'discount_policy_changed', entityType: 'discount_policy', entityId: input.role, risk: 1,
    details: { role: input.role, free_limit_bp: input.freeLimitBp, approve_ceiling_bp: input.approveCeilingBp, effective_from: input.effectiveFrom } });
  return policyFor(pool, input.role, input.effectiveFrom);
}
/** Throws unless this role is allowed to approve things (voids, refunds, cash movements, till sign-off, discounts). */
export async function requireApprover(db: Queryable, role: string): Promise<DiscountPolicy> {
  const p = await policyFor(db, role);
  if (p.approveCeilingBp <= 0) throw new HttpError(403, 'NOT_AN_APPROVER', `A ${role} cannot approve this. A manager or admin must.`);
  return p;
}

/** Does `discount` exceed `bp` basis points of `gross`? Exact integer arithmetic: exactly at the limit is allowed. */
export const exceedsBp = (discountCents: number, grossCents: number, bp: number): boolean =>
  BigInt(discountCents) * 10_000n > BigInt(bp) * BigInt(grossCents);

/** The discount as basis points of the sale, rounded UP so a discount is never understated. */
export const discountBp = (discountCents: number, grossCents: number): number =>
  Number((BigInt(discountCents) * 10_000n + BigInt(grossCents) - 1n) / BigInt(grossCents));

export interface DiscountReason { code: string; label: string; active: boolean }

export async function listDiscountReasons(db: Queryable, opts: { activeOnly?: boolean } = {}): Promise<DiscountReason[]> {
  const { rows } = await db.query<DiscountReason>(`SELECT code, label, active FROM discount_reasons WHERE (NOT $1::boolean OR active) ORDER BY code`, [opts.activeOnly ?? false]);
  return rows;
}

export async function addDiscountReason(pool: Pool, input: { code: string; label: string; actor: string }): Promise<DiscountReason> {
  if (!input.actor?.trim()) throw new HttpError(422, 'POLICY_NO_ACTOR', 'The person adding the reason is required.');
  try {
    await pool.query(`INSERT INTO discount_reasons (code, label) VALUES ($1, $2)`, [input.code, input.label?.trim()]);
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23505') throw new HttpError(409, 'REASON_EXISTS', 'That reason code already exists.');
    if (e.code === '23514') throw new HttpError(422, 'REASON_INVALID', 'A reason code is lowercase letters and underscores, with a label.');
    throw err;
  }
  await audit(pool, { actor: input.actor, action: 'discount_reason_added', entityType: 'discount_reason', entityId: input.code, risk: 0 });
  return { code: input.code, label: input.label.trim(), active: true };
}

export async function setDiscountReasonActive(pool: Pool, input: { code: string; active: boolean; actor: string }): Promise<void> {
  const { rowCount } = await pool.query(`UPDATE discount_reasons SET active = $2 WHERE code = $1`, [input.code, input.active]);
  if (!rowCount) throw new HttpError(404, 'REASON_NOT_FOUND', 'Discount reason not found.');
  await audit(pool, { actor: input.actor, action: input.active ? 'discount_reason_activated' : 'discount_reason_deactivated', entityType: 'discount_reason', entityId: input.code });
}
