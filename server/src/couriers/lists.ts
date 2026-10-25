import type { Queryable } from '../db/tx.js';

export interface OpenCollection { id: number; courierId: number; orderRef: string; amountCents: number; collectedOn: string }

/** What an organization collected that is not yet on a settled statement: the parcels a new statement can list. */
export async function listOpenCollections(db: Queryable, courierId: number): Promise<OpenCollection[]> {
  const { rows } = await db.query(
    `SELECT k.id, k.courier_id, k.order_ref, k.amount_cents, to_char(k.collected_on, 'YYYY-MM-DD') AS collected_on
       FROM org_collections k WHERE k.courier_id = $1 AND NOT EXISTS (SELECT 1 FROM org_statement_lines l WHERE l.collection_id = k.id) ORDER BY k.collected_on, k.id`, [courierId]);
  return rows.map((r) => ({ id: r.id, courierId: r.courier_id, orderRef: r.order_ref, amountCents: r.amount_cents, collectedOn: r.collected_on }));
}

export async function listCosts(db: Queryable, opts: { status?: string; courierId?: number; limit: number; offset: number }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status) { args.push(opts.status); where.push(`c.status = $${args.length}`); }
  if (opts.courierId) { args.push(opts.courierId); where.push(`c.courier_id = $${args.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM courier_costs c ${clause}`, args)).rows[0]!.n);
  const { rows } = await db.query(`SELECT c.*, k.name AS courier_name FROM courier_costs c JOIN couriers k ON k.id = c.courier_id ${clause} ORDER BY c.id DESC LIMIT ${opts.limit} OFFSET ${opts.offset}`, args);
  return { total, costs: rows.map((r) => ({ id: r.id, courierId: r.courier_id, courierName: r.courier_name, kind: r.kind, amountCents: r.amount_cents, description: r.description, orderRef: r.order_ref, receiptRef: r.receipt_ref, status: r.status, recordedBy: r.recorded_by, recordedAt: r.recorded_at, decisionReason: r.decision_reason })) };
}
