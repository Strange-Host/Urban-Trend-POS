import type { Queryable } from '../db/tx.js';
import type { OrderStatus } from './orders.js';

export interface OrderSummary {
  id: number; orderRef: string; status: OrderStatus; customerName: string; customerPhone: string; totalCents: number;
  /** What the customer still owes (the order's receivable in the ledger). */
  balanceCents: number; assignedTo: string | null; createdBy: string; createdAt: Date; dispatchedAt: Date | null; courierName: string | null;
}

/** Orders for the list screen, newest first. Search matches the reference (any spacing or case), the old UT code, the name or the phone. */
export async function listOrders(db: Queryable, opts: { status?: OrderStatus | 'active'; search?: string; assignedTo?: string; unpaidOnly?: boolean; limit: number; offset: number }): Promise<{ orders: OrderSummary[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status === 'active') where.push(`o.status IN ('awaiting_dispatch', 'dispatched')`);
  else if (opts.status) { args.push(opts.status); where.push(`o.status = $${args.length}`); }
  if (opts.assignedTo) { args.push(opts.assignedTo); where.push(`o.assigned_to = $${args.length}`); }
  if (opts.search?.trim()) {
    const raw = opts.search.trim();
    args.push(`%${raw.replace(/[%_\\]/g, '\\$&')}%`);
    const like = `$${args.length}`;
    const parts = [`o.customer_name ILIKE ${like}`, `o.order_ref ILIKE ${like}`, `EXISTS (SELECT 1 FROM order_refs r WHERE r.ref = o.order_ref AND r.legacy_ref ILIKE ${like})`];
    const digits = raw.replace(/\D/g, '');
    if (digits.length >= 3) { args.push(`%${digits}%`); parts.push(`o.phone_normalized LIKE $${args.length}`); }
    const compact = raw.replace(/[\s-]/g, '');
    if (compact !== raw && compact.length >= 3) { args.push(`%${compact}%`); parts.push(`replace(o.order_ref, '-', '') ILIKE $${args.length}`); }
    where.push(`(${parts.join(' OR ')})`);
  }
  const bal = `(SELECT COALESCE(sum(l.amount_cents), 0)::bigint FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
                 WHERE a.code = 'CUSTOMER_RECEIVABLE' AND e.order_ref = o.order_ref)`;
  const base = `FROM orders o ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const filter = opts.unpaidOnly ? `WHERE x.balance > 0 AND x.status <> 'cancelled'` : '';
  const inner = `SELECT o.*, ${bal} AS balance ${base}`;
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM (${inner}) x ${filter}`, args)).rows[0]!.n);
  const { rows } = await db.query(
    `SELECT x.*, (SELECT c.name FROM package_fees f JOIN couriers c ON c.id = f.courier_id WHERE f.order_id = x.id) AS courier_name
       FROM (${inner}) x ${filter} ORDER BY x.created_at DESC, x.id DESC LIMIT ${opts.limit} OFFSET ${opts.offset}`, args);
  return {
    total,
    orders: rows.map((r) => ({
      id: r.id, orderRef: r.order_ref, status: r.status, customerName: r.customer_name, customerPhone: r.customer_phone, totalCents: r.total_cents,
      balanceCents: r.status === 'cancelled' ? 0 : r.balance, assignedTo: r.assigned_to, createdBy: r.created_by, createdAt: r.created_at, dispatchedAt: r.dispatched_at, courierName: r.courier_name,
    })),
  };
}
