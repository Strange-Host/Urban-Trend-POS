import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { previewPayroll, type PayItem, type PayLine } from './calculate.js';
import { isDateString } from './time.js';

// A payroll run covers one period for everyone on payroll.
//   draft     calculated, can be regenerated as often as you like
//   approved  LOCKED: the figures are frozen (Rule 9) and the orders commissioned are recorded so none can earn twice
//   paid      LOCKED and paid
// Approval and payment are admin-only actions; the permission check arrives with the login system.

export interface RunCtx { pool: Pool }

export interface RunView {
  id: number;
  periodStart: string;
  periodEnd: string;
  status: 'draft' | 'approved' | 'paid';
  createdBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  paidBy: string | null;
  paidAt: Date | null;
  paymentMethod: string | null;
  paymentRef: string | null;
  checksum: string | null;
  items: PayItem[];
  totals: { grossCents: number; deductionsCents: number; netCents: number; payableCents: number; shortfallCents: number; commissionCents: number };
}

interface RunRow {
  id: number; period_start: string; period_end: string; status: RunView['status']; created_by: string; approved_by: string | null; approved_at: Date | null;
  paid_by: string | null; paid_at: Date | null; payment_method: string | null; payment_ref: string | null; checksum: string | null;
}
const RUN_COLS = `id, to_char(period_start, 'YYYY-MM-DD') AS period_start, to_char(period_end, 'YYYY-MM-DD') AS period_end, status, created_by,
                  approved_by, approved_at, paid_by, paid_at, payment_method, payment_ref, checksum`;

export async function loadItems(db: Queryable, runId: number): Promise<PayItem[]> {
  const items = await db.query(`SELECT * FROM payroll_items WHERE run_id = $1 ORDER BY staff_key`, [runId]);
  const lines = await db.query(
    `SELECT l.item_id, l.kind, to_char(l.ref_date, 'YYYY-MM-DD') AS ref_date, l.ref_text, l.quantity, l.amount_cents
       FROM payroll_item_lines l JOIN payroll_items i ON i.id = l.item_id WHERE i.run_id = $1 ORDER BY l.id`, [runId]);
  return items.rows.map((r) => ({
    staffKey: r.staff_key, daysWorked: r.days_worked, retainerCents: r.retainer_cents, unitsSold: r.units_sold, achievedSalesCents: r.achieved_sales_cents,
    targetCents: r.target_cents, achievementBp: r.achievement_bp, tier: r.tier, rateCents: r.rate_cents, commissionCents: r.commission_cents,
    bonusesCents: r.bonuses_cents, lateCents: r.late_cents, absenceCents: r.absence_cents, missingHoursCents: r.missing_hours_cents,
    advancesCents: r.advances_cents, lossDeductionsCents: r.loss_deductions_cents, grossCents: r.gross_cents, deductionsCents: r.deductions_cents,
    netCents: r.net_cents, payableCents: r.payable_cents, shortfallCents: r.shortfall_cents,
    lines: lines.rows.filter((l) => l.item_id === r.id).map((l): PayLine => ({ kind: l.kind, refDate: l.ref_date, refText: l.ref_text, quantity: l.quantity, amountCents: l.amount_cents })),
  }));
}

const sumOf = (items: PayItem[], k: keyof PayItem) => items.reduce((s, i) => s + (i[k] as number), 0);
export const totalsOf = (items: PayItem[]) => ({
  grossCents: sumOf(items, 'grossCents'), deductionsCents: sumOf(items, 'deductionsCents'), netCents: sumOf(items, 'netCents'),
  payableCents: sumOf(items, 'payableCents'), shortfallCents: sumOf(items, 'shortfallCents'), commissionCents: sumOf(items, 'commissionCents'),
});

/** A stable text form of a run's figures, used to compare a draft with a fresh calculation and to fingerprint a locked run. */
export function canonicalItems(period: { from: string; to: string }, items: PayItem[]): string {
  const rows = [...items].sort((a, b) => a.staffKey.localeCompare(b.staffKey)).map((i) => [
    i.staffKey, i.daysWorked, i.retainerCents, i.unitsSold, i.achievedSalesCents, i.targetCents, i.achievementBp, i.tier, i.rateCents, i.commissionCents,
    i.bonusesCents, i.lateCents, i.absenceCents, i.missingHoursCents, i.advancesCents, i.lossDeductionsCents, i.grossCents, i.deductionsCents, i.netCents,
    i.payableCents, i.shortfallCents, i.lines.map((l) => [l.kind, l.refDate, l.refText, l.quantity, l.amountCents]),
  ]);
  return JSON.stringify({ period: [period.from, period.to], items: rows });
}

export const fingerprint = (canonical: string) => createHash('sha256').update(canonical).digest('hex');

/** The fingerprint of a run as it is stored right now. A locked run's fingerprint must always equal the one recorded at approval. */
export async function runFingerprint(db: Queryable, runId: number): Promise<string | null> {
  const run = await db.query<RunRow>(`SELECT ${RUN_COLS} FROM payroll_runs WHERE id = $1`, [runId]);
  if (!run.rows[0]) return null;
  return fingerprint(canonicalItems({ from: run.rows[0].period_start, to: run.rows[0].period_end }, await loadItems(db, runId)));
}

export async function getRun(db: Queryable, runId: number): Promise<RunView | null> {
  const { rows } = await db.query<RunRow>(`SELECT ${RUN_COLS} FROM payroll_runs WHERE id = $1`, [runId]);
  const r = rows[0];
  if (!r) return null;
  const items = await loadItems(db, runId);
  return {
    id: r.id, periodStart: r.period_start, periodEnd: r.period_end, status: r.status, createdBy: r.created_by, approvedBy: r.approved_by, approvedAt: r.approved_at,
    paidBy: r.paid_by, paidAt: r.paid_at, paymentMethod: r.payment_method, paymentRef: r.payment_ref, checksum: r.checksum, items, totals: totalsOf(items),
  };
}

export async function listRuns(db: Queryable): Promise<Omit<RunView, 'items' | 'totals'>[]> {
  const { rows } = await db.query<RunRow>(`SELECT ${RUN_COLS} FROM payroll_runs ORDER BY period_start DESC, id DESC`);
  return rows.map((r) => ({
    id: r.id, periodStart: r.period_start, periodEnd: r.period_end, status: r.status, createdBy: r.created_by, approvedBy: r.approved_by, approvedAt: r.approved_at,
    paidBy: r.paid_by, paidAt: r.paid_at, paymentMethod: r.payment_method, paymentRef: r.payment_ref, checksum: r.checksum,
  }));
}

async function insertItems(c: pg.PoolClient, runId: number, items: PayItem[]) {
  for (const i of items) {
    const ins = await c.query<{ id: number }>(
      `INSERT INTO payroll_items (run_id, staff_key, days_worked, retainer_cents, units_sold, achieved_sales_cents, target_cents, achievement_bp, tier, rate_cents,
                                  commission_cents, bonuses_cents, late_cents, absence_cents, missing_hours_cents, advances_cents, loss_deductions_cents,
                                  gross_cents, deductions_cents, net_cents, payable_cents, shortfall_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
      [runId, i.staffKey, i.daysWorked, i.retainerCents, i.unitsSold, i.achievedSalesCents, i.targetCents, i.achievementBp, i.tier, i.rateCents, i.commissionCents,
       i.bonusesCents, i.lateCents, i.absenceCents, i.missingHoursCents, i.advancesCents, i.lossDeductionsCents, i.grossCents, i.deductionsCents, i.netCents,
       i.payableCents, i.shortfallCents]);
    for (const l of i.lines) {
      await c.query(`INSERT INTO payroll_item_lines (item_id, kind, ref_date, ref_text, quantity, amount_cents) VALUES ($1, $2, $3, $4, $5, $6)`,
        [ins.rows[0]!.id, l.kind, l.refDate, l.refText, l.quantity, l.amountCents]);
    }
  }
}

function checkPeriod(from: string, to: string) {
  if (!isDateString(from) || !isDateString(to) || to < from) {
    throw new HttpError(422, 'PAYROLL_BAD_PERIOD', 'A pay period needs a start and an end date (YYYY-MM-DD), end not before start.');
  }
}

/** Calculates the period and saves it as a draft. Running it again for the same period replaces the draft with a fresh calculation. */
export async function generateDraft(ctx: RunCtx, input: { from: string; to: string; actor: string }): Promise<RunView> {
  checkPeriod(input.from, input.to);
  if (!input.actor?.trim()) throw new HttpError(422, 'PAY_NO_ACTOR', 'The person generating payroll is required.');
  return withTransaction(ctx.pool, async (c) => {
    const locked = await c.query<{ id: number }>(
      `SELECT id FROM payroll_runs WHERE status <> 'draft' AND daterange(period_start, period_end, '[]') && daterange($1::date, $2::date, '[]') LIMIT 1`, [input.from, input.to]);
    if (locked.rows[0]) throw new HttpError(409, 'PERIOD_LOCKED', `That period overlaps payroll run ${locked.rows[0].id}, which is locked.`);

    const existing = await c.query<{ id: number }>(`SELECT id FROM payroll_runs WHERE status = 'draft' AND period_start = $1 AND period_end = $2 FOR UPDATE`, [input.from, input.to]);
    let runId: number;
    if (existing.rows[0]) {
      runId = existing.rows[0].id;
      await c.query(`DELETE FROM payroll_item_lines WHERE item_id IN (SELECT id FROM payroll_items WHERE run_id = $1)`, [runId]);
      await c.query(`DELETE FROM payroll_items WHERE run_id = $1`, [runId]);
    } else {
      runId = (await c.query<{ id: number }>(`INSERT INTO payroll_runs (period_start, period_end, created_by) VALUES ($1, $2, $3) RETURNING id`, [input.from, input.to, input.actor.trim()])).rows[0]!.id;
    }
    await insertItems(c, runId, await previewPayroll(c, { from: input.from, to: input.to }));
    return (await getRun(c, runId))!;
  });
}

/**
 * Approves a draft, which LOCKS it. The draft is recalculated first and must match what is saved: if anything has changed
 * since it was generated (a payment secured, an adjustment added), approval is refused so what is frozen is exactly what is
 * true now, and what was reviewed. Every order commissioned in the run is recorded, so none can ever earn commission twice.
 */
export async function approveRun(ctx: RunCtx, input: { runId: number; actor: string }): Promise<RunView> {
  if (!input.actor?.trim()) throw new HttpError(422, 'PAY_NO_ACTOR', 'The approver is required.');
  return withTransaction(ctx.pool, async (c) => {
    const found = await c.query<RunRow>(`SELECT ${RUN_COLS} FROM payroll_runs WHERE id = $1 FOR UPDATE`, [input.runId]);
    const run = found.rows[0];
    if (!run) throw new HttpError(404, 'RUN_NOT_FOUND', 'Payroll run not found.');
    if (run.status !== 'draft') throw new HttpError(409, 'RUN_NOT_DRAFT', `This run is already ${run.status}.`);

    const period = { from: run.period_start, to: run.period_end };
    const stored = await loadItems(c, run.id);
    const fresh = await previewPayroll(c, period);
    if (fresh.length === 0) throw new HttpError(409, 'RUN_EMPTY', 'Nobody is on payroll for this period, so there is nothing to approve.');
    if (canonicalItems(period, stored) !== canonicalItems(period, fresh)) {
      throw new HttpError(409, 'RUN_STALE', 'Something has changed since this draft was generated. Generate it again, review it, then approve.');
    }

    const orderRefs = fresh.flatMap((i) => i.orders.map((o) => o.orderRef));
    if (orderRefs.length) {
      const dup = await c.query<{ order_ref: string }>(`SELECT order_ref FROM commissioned_orders WHERE order_ref = ANY($1)`, [orderRefs]);
      if (dup.rows[0]) throw new HttpError(409, 'COMMISSION_ALREADY_PAID', `Order ${dup.rows[0].order_ref} has already earned commission in another payroll run.`);
    }
    for (const i of fresh) {
      for (const o of i.orders) {
        await c.query(`INSERT INTO commissioned_orders (order_ref, run_id, staff_key, units, total_cents, secured_at) VALUES ($1, $2, $3, $4, $5, $6)`,
          [o.orderRef, run.id, i.staffKey, o.units, o.totalCents, o.securedAt]);
      }
    }
    const checksum = fingerprint(canonicalItems(period, stored));
    try {
      await c.query(`UPDATE payroll_runs SET status = 'approved', approved_by = $2, approved_at = now(), checksum = $3 WHERE id = $1`, [run.id, input.actor.trim(), checksum]);
    } catch (err) {
      if ((err as { code?: string }).code === '23P01') throw new HttpError(409, 'PERIOD_LOCKED', 'Another locked payroll run already covers part of this period.');
      throw err;
    }
    return (await getRun(c, run.id))!;
  });
}

/** Records that an approved run has been paid. The run stays exactly as approved. */
export async function markRunPaid(ctx: RunCtx, input: { runId: number; method: 'mpesa' | 'bank' | 'cash'; paymentRef?: string; actor: string }): Promise<RunView> {
  if (!input.actor?.trim()) throw new HttpError(422, 'PAY_NO_ACTOR', 'The person paying is required.');
  if (!['mpesa', 'bank', 'cash'].includes(input.method)) throw new HttpError(422, 'PAYOUT_BAD_METHOD', 'Pay by mpesa, bank or cash.');
  if (input.method !== 'cash' && !input.paymentRef?.trim()) throw new HttpError(422, 'PAYOUT_REFERENCE_REQUIRED', 'Enter the payment reference.');
  return withTransaction(ctx.pool, async (c) => {
    const found = await c.query<{ status: string }>(`SELECT status FROM payroll_runs WHERE id = $1 FOR UPDATE`, [input.runId]);
    if (!found.rows[0]) throw new HttpError(404, 'RUN_NOT_FOUND', 'Payroll run not found.');
    if (found.rows[0].status !== 'approved') throw new HttpError(409, 'RUN_NOT_APPROVED', found.rows[0].status === 'paid' ? 'This run has already been paid.' : 'Only an approved run can be paid.');
    await c.query(`UPDATE payroll_runs SET status = 'paid', paid_by = $2, paid_at = now(), payment_method = $3, payment_ref = $4 WHERE id = $1`,
      [input.runId, input.actor.trim(), input.method, input.paymentRef?.trim() ?? null]);
    return (await getRun(c, input.runId))!;
  });
}
