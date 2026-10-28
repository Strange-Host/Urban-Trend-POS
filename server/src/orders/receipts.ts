import type { Queryable } from '../db/tx.js';

// A read-only list of the money that has been booked against orders: one receipt per payment (paybill, organization remittance,
// cash at the shop, bank). This is the new server's answer to the legacy Payments tab. Nothing here writes: payments arrive on their own
// and are matched; a wrong one is corrected through suspense, never edited.

export interface ReceiptRow {
  id: number; receiptNo: string; orderRef: string; amountCents: number;
  method: 'mpesa_paybill' | 'organization_remittance' | 'cash' | 'bank'; externalRef: string | null; issuedAt: Date; actor: string;
}
const METHODS = ['mpesa_paybill', 'organization_remittance', 'cash', 'bank'];

export async function listReceipts(db: Queryable, opts: { method?: string; search?: string; limit: number; offset: number }) {
  const args: unknown[] = [];
  const where: string[] = [];
  if (opts.method && METHODS.includes(opts.method)) { args.push(opts.method); where.push(`method = $${args.length}`); }
  if (opts.search?.trim()) {
    args.push(`%${opts.search.trim().replace(/[%_\\]/g, '\\$&')}%`);
    where.push(`(order_ref ILIKE $${args.length} OR receipt_no ILIKE $${args.length} OR external_ref ILIKE $${args.length})`);
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM payment_receipts ${w}`, args)).rows[0]!.n);
  const { rows } = await db.query(
    `SELECT id, receipt_no, order_ref, amount_cents, method, external_ref, issued_at, actor FROM payment_receipts ${w}
      ORDER BY issued_at DESC, id DESC LIMIT ${Math.min(Math.max(opts.limit, 1), 200)} OFFSET ${Math.max(opts.offset, 0)}`, args);
  const sums = await db.query<{ method: string; total: string; n: string }>(`SELECT method, sum(amount_cents) AS total, count(*) AS n FROM payment_receipts GROUP BY method ORDER BY method`);
  return {
    total,
    receipts: rows.map((r): ReceiptRow => ({ id: r.id, receiptNo: r.receipt_no, orderRef: r.order_ref, amountCents: Number(r.amount_cents), method: r.method, externalRef: r.external_ref, issuedAt: r.issued_at, actor: r.actor })),
    summary: { byMethod: sums.rows.map((s) => ({ method: s.method, totalCents: Number(s.total), count: Number(s.n) })) },
  };
}
