import type { Queryable } from '../db/tx.js';
import { organizationStanding } from '../couriers/organizations.js';

// "Money at risk": every place where money or goods could be going missing, with the age and whose it is.
// This is the data behind the manager's daily page. Later phases add their own kinds here (payroll, discounts).

export type RiskKind =
  | 'dispatched_no_outcome' | 'delivered_unpaid' | 'unmatched_payment' | 'returning'
  | 'courier_unpaid' | 'dispatch_no_fee' | 'organization_overdue' | 'cash_not_deposited'
  | 'till_variance_unsigned' | 'till_session_left_open';

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
  /** Package fees and approved costs we owe a courier, unpaid for this long, are flagged. */
  courierUnpaidDays?: number;
  /** Shop cash held by a staff member and not deposited for this long is flagged. */
  cashHeldDays?: number;
  /** A till session still open after this many hours is flagged (it should have been closed out). */
  sessionOpenHours?: number;
}

export async function moneyAtRisk(db: Queryable, opts: RiskOptions = {}): Promise<RiskItem[]> {
  const now = opts.now ?? new Date();
  const noOutcomeDays = opts.dispatchedNoOutcomeDays ?? 3;
  const unpaidDays = opts.deliveredUnpaidDays ?? 2;
  const returningDays = opts.returningDays ?? 3;
  const courierUnpaidDays = opts.courierUnpaidDays ?? 7;
  const cashHeldDays = opts.cashHeldDays ?? 2;
  const sessionOpenHours = opts.sessionOpenHours ?? 20;

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

  const extra: typeof rows = [];

  // Courier money we owe and have not paid: one line per courier, aged by their oldest unpaid item.
  const unpaid = await db.query<{ id: number; name: string; amount: number; since: Date; n: number }>(
    `WITH items AS (
       SELECT f.courier_id, f.amount_cents AS amt, f.recorded_at AS at FROM package_fees f
        WHERE f.amount_cents > 0 AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.package_fee_id = f.id)
       UNION ALL
       SELECT k.courier_id, k.amount_cents, k.decided_at FROM courier_costs k
        WHERE k.status = 'approved' AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.courier_cost_id = k.id))
     SELECT c.id, c.name, sum(items.amt)::bigint AS amount, min(items.at) AS since, count(*)::bigint AS n
       FROM items JOIN couriers c ON c.id = items.courier_id GROUP BY c.id, c.name
     HAVING min(items.at) < $1::timestamptz - make_interval(days => $2::int)`, [now, courierUnpaidDays]);
  for (const u of unpaid.rows) extra.push({ kind: 'courier_unpaid', order_ref: null, amount: u.amount, since: u.since, owner: null, detail: `We owe ${u.name} for ${u.n} unpaid item(s)` });

  // A dispatch with no package fee line (for example one brought in from the old system).
  const noFee = await db.query<{ order_ref: string; amount: number; since: Date; owner: string | null }>(
    `SELECT o.order_ref, o.total_cents AS amount, COALESCE(o.dispatched_at, o.updated_at) AS since, o.assigned_to AS owner
       FROM orders o WHERE o.status IN ('dispatched', 'delivered', 'returning') AND NOT EXISTS (SELECT 1 FROM package_fees f WHERE f.order_id = o.id)`);
  for (const n of noFee.rows) extra.push({ kind: 'dispatch_no_fee', order_ref: n.order_ref, amount: n.amount, since: n.since, owner: n.owner, detail: 'Dispatched with no package fee line' });

  // Organizations holding customer money past their overdue limit.
  const orgs = await db.query<{ id: number; name: string }>(`SELECT id, name FROM couriers WHERE kind = 'organization' AND collects_payment`);
  for (const o of orgs.rows) {
    const st = await organizationStanding(db, o.id, now);
    if (st.overdueCents > 0) {
      const oldest = await db.query<{ d: Date }>(`SELECT min(collected_on)::timestamptz AS d FROM org_collections WHERE courier_id = $1`, [o.id]);
      extra.push({ kind: 'organization_overdue', order_ref: null, amount: st.overdueCents, since: oldest.rows[0]!.d, owner: null,
        detail: `${o.name} holds overdue money${st.paused ? ' and is paused for new collect-on-delivery parcels' : ''}` });
    }
  }

  // Shop cash still in someone's hands.
  const cash = await db.query<{ order_ref: string; amount: number; since: Date; holder: string }>(
    `SELECT order_ref, amount_cents AS amount, opened_at AS since, holder FROM custody_records
      WHERE status = 'open' AND opened_at < $1::timestamptz - make_interval(days => $2::int)`, [now, cashHeldDays]);
  for (const k of cash.rows) extra.push({ kind: 'cash_not_deposited', order_ref: k.order_ref, amount: k.amount, since: k.since, owner: k.holder, detail: `Shop cash held by ${k.holder}, not yet deposited` });

  // A till close-out with a large difference that no manager has signed off.
  const unsigned = await db.query<{ id: number; cashier: string; amount: number; since: Date }>(
    `SELECT s.id, s.cashier, COALESCE((SELECT sum(abs(variance_cents)) FROM cash_session_counts c WHERE c.session_id = s.id), 0)::bigint AS amount, s.closed_at AS since
       FROM cash_sessions s WHERE s.status = 'closed' AND s.signoff_required`);
  for (const u of unsigned.rows) extra.push({ kind: 'till_variance_unsigned', order_ref: null, amount: u.amount, since: u.since, owner: u.cashier, detail: `Till session ${u.id} closed out of balance and is waiting for a manager's sign-off` });

  // A till session left open.
  const open = await db.query<{ id: number; cashier: string; since: Date }>(
    `SELECT id, cashier, opened_at AS since FROM cash_sessions WHERE status = 'open' AND opened_at < $1::timestamptz - make_interval(hours => $2::int)`, [now, sessionOpenHours]);
  for (const o of open.rows) extra.push({ kind: 'till_session_left_open', order_ref: null, amount: 0, since: o.since, owner: o.cashier, detail: `Till session ${o.id} has been open since ${o.since.toISOString().slice(0, 16)}Z and has not been closed out` });

  return [...rows, ...extra]
    .map((r) => ({
      kind: r.kind, orderRef: r.order_ref, amountCents: r.amount, since: r.since,
      ageDays: Math.floor((now.getTime() - r.since.getTime()) / 86_400_000), owner: r.owner, detail: r.detail,
    }))
    .sort((a, b) => b.ageDays - a.ageDays || b.amountCents - a.amountCents);
}
