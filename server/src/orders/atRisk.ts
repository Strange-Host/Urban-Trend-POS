import type { Queryable } from '../db/tx.js';

// "Money at risk": every place where money or goods could be going missing, with the age and whose it is.
// This is the data behind the manager's daily page. Items from later phases (courier fees, organization balances,
// dispatches without a fee) are added here as those phases arrive.

export type RiskKind = 'dispatched_no_outcome' | 'delivered_unpaid' | 'unmatched_payment' | 'returning';

export interface RiskItem {
  kind: RiskKind;
  orderRef: string | null;
  /** The amount involved: what is owed, or what is sitting unmatched. */
  amountCents: number;
  since: Date;
  ageDays: number;
  owner: string | null;
  detail: string;
}

export interface RiskOptions {
  now?: Date;
  /** A dispatched order with no delivery outcome for this long is flagged. */
  dispatchedNoOutcomeDays?: number;
  /** A delivered order that is still not fully paid after this long is flagged. */
  deliveredUnpaidDays?: number;
  /** An order that failed delivery and has not come back for this long is flagged. */
  returningDays?: number;
}

export async function moneyAtRisk(db: Queryable, opts: RiskOptions = {}): Promise<RiskItem[]> {
  const now = opts.now ?? new Date();
  const noOutcomeDays = opts.dispatchedNoOutcomeDays ?? 3;
  const unpaidDays = opts.deliveredUnpaidDays ?? 2;
  const returningDays = opts.returningDays ?? 3;

  const { rows } = await db.query<{ kind: RiskKind; order_ref: string | null; amount: number; since: Date; owner: string | null; detail: string }>(
    `WITH owed AS (
       SELECT e.order_ref, sum(l.amount_cents)::bigint AS balance
         FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
        WHERE a.code = 'CUSTOMER_RECEIVABLE' AND e.order_ref IS NOT NULL GROUP BY e.order_ref
     )
     SELECT 'dispatched_no_outcome' AS kind, o.order_ref, COALESCE(w.balance, 0) AS amount,
            COALESCE((SELECT max(at.recorded_at) FROM delivery_attempts at WHERE at.order_id = o.id), o.dispatched_at) AS since,
            o.assigned_to AS owner, 'Dispatched with no delivery outcome recorded' AS detail
       FROM orders o LEFT JOIN owed w ON w.order_ref = o.order_ref
      WHERE o.status = 'dispatched'
        AND COALESCE((SELECT max(at.recorded_at) FROM delivery_attempts at WHERE at.order_id = o.id), o.dispatched_at) < $1::timestamptz - make_interval(days => $2::int)
     UNION ALL
     SELECT 'delivered_unpaid', o.order_ref, w.balance, o.delivered_at, o.assigned_to, 'Delivered but not fully paid'
       FROM orders o JOIN owed w ON w.order_ref = o.order_ref
      WHERE o.status = 'delivered' AND w.balance > 0 AND o.delivered_at < $1::timestamptz - make_interval(days => $3::int)
     UNION ALL
     SELECT 'unmatched_payment', p.order_ref,
            (x.amount_cents - COALESCE((SELECT sum(r.amount_cents) FROM exception_resolutions r WHERE r.exception_id = x.id), 0))::bigint,
            x.created_at, NULL,
            CASE x.kind WHEN 'unmatched' THEN 'Payment ' || p.trans_code || ' matched no order' ELSE 'Overpayment ' || p.trans_code || ': excess waiting in suspense' END
       FROM payment_exceptions x JOIN paybill_payments p ON p.id = x.payment_id
      WHERE x.amount_cents > COALESCE((SELECT sum(r.amount_cents) FROM exception_resolutions r WHERE r.exception_id = x.id), 0)
     UNION ALL
     SELECT 'returning', o.order_ref, COALESCE(w.balance, 0),
            COALESCE((SELECT max(ev.at) FROM order_events ev WHERE ev.order_id = o.id AND ev.type = 'returning'), o.updated_at), o.assigned_to,
            'Coming back from a failed delivery'
       FROM orders o LEFT JOIN owed w ON w.order_ref = o.order_ref
      WHERE o.status = 'returning'
        AND COALESCE((SELECT max(ev.at) FROM order_events ev WHERE ev.order_id = o.id AND ev.type = 'returning'), o.updated_at) < $1::timestamptz - make_interval(days => $4::int)`,
    [now, noOutcomeDays, unpaidDays, returningDays]);

  return rows
    .map((r) => ({
      kind: r.kind, orderRef: r.order_ref, amountCents: r.amount, since: r.since,
      ageDays: Math.floor((now.getTime() - r.since.getTime()) / 86_400_000), owner: r.owner, detail: r.detail,
    }))
    .sort((a, b) => b.ageDays - a.ageDays || b.amountCents - a.amountCents);
}
