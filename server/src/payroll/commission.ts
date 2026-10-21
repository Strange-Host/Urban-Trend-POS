import type { Queryable } from '../db/tx.js';

// RULE 8: commission is earned only on SECURE money.
//
// An order counts for commission only when its whole total is secure, and it is dispatched (not cancelled or coming back).
// Money is secure when:
//   - a paybill payment has matched an order reference (including suspense money a person matched to it), or a bank receipt;
//   - shop cash has been DEPOSITED or handed to the till (cash in someone's pocket is not secure);
//   - an organization has REMITTED: the part of its collection that a statement settled (cash received plus the fees netted).
//     Merely collecting the money does not count. Money collected by an organization that has not remitted earns nothing yet.
// The day an order becomes fully secure (and dispatched) is the day it counts, so a parcel is commissioned in the pay
// period in which its money was actually safe, not when it was ordered or dispatched.

export interface SecuredOrder {
  orderRef: string;
  staffKey: string;
  totalCents: number;
  units: number;
  /** When it became fully secure and dispatched: the later of its dispatch and its last piece of secure money. */
  securedAt: Date;
  status: string;
}

export interface SecuredFilter {
  /** Only orders that became secure at or after this instant. */
  from?: Date;
  /** Only orders that became secure strictly before this instant. */
  to?: Date;
  staffKey?: string;
  orderRefs?: string[];
}

export async function securedOrders(db: Queryable, f: SecuredFilter = {}): Promise<SecuredOrder[]> {
  const { rows } = await db.query<{ order_ref: string; staff: string; total: number; units: number; secured_at: Date; status: string }>(
    `WITH paid AS (   -- matched paybill money, suspense applied by a person, bank receipts: secure on receipt
       SELECT r.order_ref, sum(r.amount_cents)::bigint AS cents, max(r.issued_at) AS at
         FROM payment_receipts r WHERE r.method <> 'cash' GROUP BY r.order_ref
     ), cash AS (    -- shop cash: secure only once its custody record is deposited
       SELECT r.order_ref, sum(r.amount_cents)::bigint AS cents, max(c.closed_at) AS at
         FROM payment_receipts r JOIN custody_records c ON c.receipt_no = r.receipt_no
        WHERE r.method = 'cash' AND c.status = 'deposited' GROUP BY r.order_ref
     ), org AS (     -- organization money: only the part a statement settled
       SELECT k.order_ref, sum(l.secured_cents)::bigint AS cents, max(s.created_at) AS at
         FROM org_statement_lines l JOIN org_collections k ON k.id = l.collection_id JOIN org_statements s ON s.id = l.statement_id
        GROUP BY k.order_ref
     ), units AS (
       SELECT order_id, sum(quantity)::bigint AS n FROM order_items GROUP BY order_id
     )
     SELECT o.order_ref, o.assigned_to AS staff, o.total_cents AS total, COALESCE(u.n, 0)::int AS units, o.status,
            GREATEST(o.dispatched_at, paid.at, cash.at, org.at) AS secured_at
       FROM orders o
       LEFT JOIN paid ON paid.order_ref = o.order_ref
       LEFT JOIN cash ON cash.order_ref = o.order_ref
       LEFT JOIN org  ON org.order_ref  = o.order_ref
       LEFT JOIN units u ON u.order_id = o.id
      WHERE o.assigned_to IS NOT NULL
        AND o.status IN ('dispatched', 'delivered')
        AND o.dispatched_at IS NOT NULL
        AND COALESCE(paid.cents, 0) + COALESCE(cash.cents, 0) + COALESCE(org.cents, 0) = o.total_cents
        AND ($1::timestamptz IS NULL OR GREATEST(o.dispatched_at, paid.at, cash.at, org.at) >= $1)
        AND ($2::timestamptz IS NULL OR GREATEST(o.dispatched_at, paid.at, cash.at, org.at) <  $2)
        AND ($3::text IS NULL OR o.assigned_to = $3)
        AND ($4::text[] IS NULL OR o.order_ref = ANY($4))
      ORDER BY secured_at, o.order_ref`,
    [f.from ?? null, f.to ?? null, f.staffKey ?? null, f.orderRefs ?? null]);
  return rows.map((r) => ({ orderRef: r.order_ref, staffKey: r.staff, totalCents: r.total, units: r.units, securedAt: r.secured_at, status: r.status }));
}
