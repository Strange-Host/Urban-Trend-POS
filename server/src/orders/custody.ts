import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { cr, dr, postEntryTx } from '../ledger/ledger.js';

// Cash taken at the shop is an exception (see recordShopCash). The staff member who took it holds it, on a custody
// record, until it is deposited or handed to the till. Open custody ages on the money-at-risk page.

export interface CustodyRecord { id: number; holder: string; orderRef: string; amountCents: number; receiptNo: string | null; openedAt: Date }

export async function listOpenCustody(db: Queryable): Promise<CustodyRecord[]> {
  const { rows } = await db.query<{ id: number; holder: string; order_ref: string; amount_cents: number; receipt_no: string | null; opened_at: Date }>(
    `SELECT id, holder, order_ref, amount_cents, receipt_no, opened_at FROM custody_records WHERE status = 'open' ORDER BY opened_at, id`);
  return rows.map((r) => ({ id: r.id, holder: r.holder, orderRef: r.order_ref, amountCents: r.amount_cents, receiptNo: r.receipt_no, openedAt: r.opened_at }));
}

/** The cash is deposited or handed to the till: staff cash in hand down, till up. */
export async function depositCustody(ctx: { pool: Pool }, input: { custodyId: number; actor: string }): Promise<{ amountCents: number }> {
  if (!input.actor?.trim()) throw new HttpError(422, 'CUSTODY_NO_ACTOR', 'The person depositing the cash is required.');
  return withTransaction(ctx.pool, async (c) => {
    const { rows } = await c.query<{ id: number; amount_cents: number; order_ref: string; status: string; holder: string }>(
      `SELECT id, amount_cents, order_ref, status, holder FROM custody_records WHERE id = $1 FOR UPDATE`, [input.custodyId]);
    const rec = rows[0];
    if (!rec) throw new HttpError(404, 'CUSTODY_NOT_FOUND', 'Custody record not found.');
    if (rec.status !== 'open') throw new HttpError(409, 'CUSTODY_ALREADY_DEPOSITED', 'This cash has already been deposited.');
    const { entry } = await postEntryTx(c, {
      description: `Shop cash for ${rec.order_ref} deposited (held by ${rec.holder})`, actor: input.actor, orderRef: rec.order_ref,
      lines: [dr('TILL', rec.amount_cents), cr('STAFF_CASH_IN_HAND', rec.amount_cents)],
    });
    await c.query(`UPDATE custody_records SET status = 'deposited', closed_by = $2, closed_at = now(), close_entry_id = $3 WHERE id = $1`, [rec.id, input.actor.trim(), entry.id]);
    return { amountCents: rec.amount_cents };
  });
}
