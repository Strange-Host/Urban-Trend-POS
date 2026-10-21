import type { Queryable } from '../db/tx.js';
import { discountBp } from './policy.js';

export interface DateRange { from?: Date; to?: Date } // from inclusive, to exclusive

export interface StaffDiscountRow {
  cashier: string;
  sales: number;
  grossCents: number;
  discountCents: number;
  /** Total discount as a share of gross sales, in basis points. */
  discountBp: number;
  discountedSales: number;
  /** How many of the discounted sales needed (and got) a manager's approval. */
  approvedSales: number;
  byReason: { reason: string; sales: number; discountCents: number }[];
}

/** Discounts given per cashier, heaviest first: how much, how often, how many needed approval, and why. Voided sales are excluded. */
export async function discountsByStaff(db: Queryable, range: DateRange = {}): Promise<StaffDiscountRow[]> {
  const args = [range.from ?? null, range.to ?? null];
  const filter = `s.status = 'completed' AND ($1::timestamptz IS NULL OR s.created_at >= $1) AND ($2::timestamptz IS NULL OR s.created_at < $2)`;
  const { rows } = await db.query<{ cashier: string; sales: number; gross: number; disc: number; discounted: number; approved: number }>(
    `SELECT s.cashier, count(*)::int AS sales, sum(s.gross_cents)::bigint AS gross, sum(s.line_discount_cents + s.sale_discount_cents)::bigint AS disc,
            count(*) FILTER (WHERE s.line_discount_cents + s.sale_discount_cents > 0)::int AS discounted, count(a.id)::int AS approved
       FROM sales s LEFT JOIN discount_approvals a ON a.sale_id = s.id WHERE ${filter} GROUP BY s.cashier`, args);
  const reasons = await db.query<{ cashier: string; reason: string; sales: number; disc: number }>(
    `SELECT s.cashier, s.discount_reason AS reason, count(*)::int AS sales, sum(s.line_discount_cents + s.sale_discount_cents)::bigint AS disc
       FROM sales s WHERE ${filter} AND s.discount_reason IS NOT NULL GROUP BY s.cashier, s.discount_reason ORDER BY disc DESC`, args);
  return rows
    .map((r) => ({
      cashier: r.cashier, sales: r.sales, grossCents: r.gross, discountCents: r.disc, discountBp: r.gross > 0 ? discountBp(r.disc, r.gross) : 0,
      discountedSales: r.discounted, approvedSales: r.approved,
      byReason: reasons.rows.filter((x) => x.cashier === r.cashier).map((x) => ({ reason: x.reason, sales: x.sales, discountCents: x.disc })),
    }))
    .sort((a, b) => b.discountBp - a.discountBp || b.discountCents - a.discountCents || a.cashier.localeCompare(b.cashier));
}

export interface RiskyActionsRow {
  actor: string;
  voids: { count: number; cents: number };
  refunds: { count: number; cents: number };
  discounts: { count: number; cents: number; approvedCount: number };
  paidOuts: { count: number; cents: number };
  drops: { count: number; cents: number };
  topUps: { count: number; cents: number };
  tillVarianceCents: number;
  /** Close-outs that were large enough to need a manager's sign-off. */
  sessionsNeedingSignoff: number;
  /** The sum of the risk levels (0 routine, 1 notable, 2 risky) of everything this person did. */
  riskScore: number;
}

/** One row per person: how often and how much they voided, refunded, discounted, paid out, dropped, and how far their tills were out. Riskiest first. */
export async function riskyActions(db: Queryable, range: DateRange = {}): Promise<RiskyActionsRow[]> {
  const { rows } = await db.query<Record<string, number | string>>(
    `SELECT actor,
       count(*) FILTER (WHERE action = 'void')::int AS void_n,              COALESCE(sum(amount_cents) FILTER (WHERE action = 'void'), 0)::bigint AS void_c,
       count(*) FILTER (WHERE action = 'refund')::int AS refund_n,          COALESCE(sum(amount_cents) FILTER (WHERE action = 'refund'), 0)::bigint AS refund_c,
       count(*) FILTER (WHERE action = 'discount_given')::int AS disc_n,    COALESCE(sum(amount_cents) FILTER (WHERE action = 'discount_given'), 0)::bigint AS disc_c,
       count(*) FILTER (WHERE action = 'discount_given' AND risk = 2)::int AS disc_approved,
       count(*) FILTER (WHERE action = 'cash_paid_out')::int AS out_n,      COALESCE(sum(amount_cents) FILTER (WHERE action = 'cash_paid_out'), 0)::bigint AS out_c,
       count(*) FILTER (WHERE action = 'cash_drop')::int AS drop_n,         COALESCE(sum(amount_cents) FILTER (WHERE action = 'cash_drop'), 0)::bigint AS drop_c,
       count(*) FILTER (WHERE action = 'cash_top_up')::int AS up_n,         COALESCE(sum(amount_cents) FILTER (WHERE action = 'cash_top_up'), 0)::bigint AS up_c,
       COALESCE(sum(amount_cents) FILTER (WHERE action = 'session_closed'), 0)::bigint AS variance,
       count(*) FILTER (WHERE action = 'session_closed' AND risk = 2)::int AS signoffs,
       COALESCE(sum(risk), 0)::int AS score
       FROM audit_log WHERE ($1::timestamptz IS NULL OR at >= $1) AND ($2::timestamptz IS NULL OR at < $2) GROUP BY actor`,
    [range.from ?? null, range.to ?? null]);
  const n = (v: unknown) => Number(v);
  return rows
    .map((r) => ({
      actor: String(r.actor),
      voids: { count: n(r.void_n), cents: n(r.void_c) }, refunds: { count: n(r.refund_n), cents: n(r.refund_c) },
      discounts: { count: n(r.disc_n), cents: n(r.disc_c), approvedCount: n(r.disc_approved) },
      paidOuts: { count: n(r.out_n), cents: n(r.out_c) }, drops: { count: n(r.drop_n), cents: n(r.drop_c) }, topUps: { count: n(r.up_n), cents: n(r.up_c) },
      tillVarianceCents: n(r.variance), sessionsNeedingSignoff: n(r.signoffs), riskScore: n(r.score),
    }))
    .filter((r) => r.riskScore > 0)
    .sort((a, b) => b.riskScore - a.riskScore || a.actor.localeCompare(b.actor));
}
