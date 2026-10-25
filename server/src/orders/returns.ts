import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { accountBalance, cr, dr, postEntryTx } from '../ledger/ledger.js';
import { resolveOrderRef } from '../ledger/refs.js';
import { audit } from '../pos/audit.js';
import { postMovements } from '../stock/stock.js';
import { getOrderTx, type OrderView } from './orders.js';

export interface ReturnItemInput { orderItemId: number; restockQuantity: number; damagedQuantity?: number }

/**
 * The parcel of a failed delivery is physically back. A manager counts what came back, line by line:
 *   - restocked goods go back on the shelf (stock up),
 *   - damaged goods come back but are not restocked,
 *   - anything neither restocked nor damaged is recorded as missing (lost in transit): needs a note.
 * Money: the part of the order the customer never paid is revenue that was not earned, so it is taken back off sales. Money the
 * customer DID pay stays against the order as their credit, to be refunded; it is reported, never silently swallowed.
 * The package fee already owed to the courier is untouched, and any return-trip cost is its own courier cost.
 */
export async function receiveReturnedOrder(ctx: { pool: Pool }, input: { orderRef: string; items: ReturnItemInput[]; notes?: string; actor: string; role?: string }): Promise<{ order: OrderView; unpaidWrittenOffCents: number; customerCreditCents: number }> {
  if (!input.actor?.trim()) throw new HttpError(422, 'RETURN_NO_ACTOR', 'The person receiving the parcel is required.');
  if (!Array.isArray(input.items) || input.items.length === 0) throw new HttpError(422, 'RETURN_NO_ITEMS', 'Say what came back, line by line.');
  if (new Set(input.items.map((i) => i.orderItemId)).size !== input.items.length) throw new HttpError(422, 'RETURN_DUPLICATE_ITEM', 'List each line once.');
  for (const i of input.items) {
    for (const v of [i.restockQuantity, i.damagedQuantity ?? 0]) if (!Number.isSafeInteger(v) || v < 0) throw new HttpError(422, 'RETURN_BAD_QUANTITY', 'Quantities must be whole numbers, zero or more.');
  }

  return withTransaction(ctx.pool, async (c) => {
    const ref = await resolveOrderRef(c, input.orderRef);
    const found = ref ? await c.query<{ id: number; order_ref: string; status: string }>(`SELECT id, order_ref, status FROM orders WHERE order_ref = $1 FOR UPDATE`, [ref.ref]) : { rows: [] };
    const o = found.rows[0];
    if (!o) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    if (o.status !== 'returning') throw new HttpError(409, 'ORDER_WRONG_STATE', `Only an order that is returning can be received back. This one is ${o.status.replace('_', ' ')}.`);

    const lines = await c.query<{ id: number; quantity: number; product_id: number | null; track_stock: boolean | null; name: string }>(
      `SELECT i.id, i.quantity, i.product_id, p.track_stock, i.name FROM order_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.order_id = $1 ORDER BY i.id`, [o.id]);
    const byId = new Map(lines.rows.map((l) => [l.id, l]));
    for (const i of input.items) if (!byId.has(i.orderItemId)) throw new HttpError(404, 'ORDER_ITEM_NOT_FOUND', `Line ${i.orderItemId} is not on this order.`);

    const given = new Map(input.items.map((i) => [i.orderItemId, i]));
    const rows: { itemId: number; restocked: number; damaged: number; missing: number; name: string }[] = [];
    let anyMissing = false;
    for (const l of lines.rows) {
      const g = given.get(l.id);
      const restocked = g?.restockQuantity ?? 0, damaged = g?.damagedQuantity ?? 0;
      if (restocked + damaged > l.quantity) throw new HttpError(422, 'RETURN_EXCEEDS_SENT', `"${l.name}": ${restocked + damaged} came back but only ${l.quantity} were sent.`);
      const missing = l.quantity - restocked - damaged;
      if (missing > 0) anyMissing = true;
      rows.push({ itemId: l.id, restocked, damaged, missing, name: l.name });
    }
    if (anyMissing && !input.notes?.trim()) throw new HttpError(422, 'RETURN_MISSING_NEEDS_NOTE', 'Some of the goods did not come back. Add a note saying what happened.');

    // money first: the unpaid part of the order was never earned
    const balance = await accountBalance(c, 'CUSTOMER_RECEIVABLE', { orderRef: o.order_ref });
    let entryId: number | null = null;
    if (balance > 0) {
      const { entry } = await postEntryTx(c, {
        description: `Order ${o.order_ref} returned: unpaid balance taken off sales`, actor: input.actor, orderRef: o.order_ref,
        idempotencyKey: `order-returned:${o.order_ref}`, lines: [dr('SALES', balance), cr('CUSTOMER_RECEIVABLE', balance)],
      });
      entryId = entry.id;
    }

    const ret = await c.query<{ id: number }>(
      `INSERT INTO order_returns (order_id, order_ref, received_by, notes, unpaid_written_off_cents, entry_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [o.id, o.order_ref, input.actor.trim(), input.notes?.trim() || null, Math.max(balance, 0), entryId]);
    for (const r of rows) {
      await c.query(`INSERT INTO order_return_items (return_id, order_item_id, restocked, damaged, missing) VALUES ($1, $2, $3, $4, $5)`, [ret.rows[0]!.id, r.itemId, r.restocked, r.damaged, r.missing]);
    }

    // stock: only restocked goods go back on the shelf (they left stock at dispatch)
    const perProduct = new Map<number, number>();
    for (const r of rows) {
      const l = byId.get(r.itemId)!;
      if (l.product_id && l.track_stock && r.restocked > 0) perProduct.set(l.product_id, (perProduct.get(l.product_id) ?? 0) + r.restocked);
    }
    await postMovements(c, [...perProduct].sort((a, b) => a[0] - b[0]).map(([productId, q]) => ({ productId, type: 'return_restock' as const, quantity: q, actor: input.actor.trim(), ref: { type: 'order' as const, id: o.id } })));

    await c.query(`UPDATE orders SET status = 'returned', updated_at = now() WHERE id = $1`, [o.id]);
    const totals = rows.reduce((t, r) => ({ restocked: t.restocked + r.restocked, damaged: t.damaged + r.damaged, missing: t.missing + r.missing }), { restocked: 0, damaged: 0, missing: 0 });
    await c.query(`INSERT INTO order_events (order_id, order_ref, type, data, actor) VALUES ($1, $2, 'returned', $3, $4)`, [o.id, o.order_ref, JSON.stringify({ ...totals, unpaid_written_off_cents: Math.max(balance, 0) }), input.actor.trim()]);
    await audit(c, { actor: input.actor, role: input.role, action: 'order_return_received', entityType: 'order', entityId: o.order_ref, amountCents: Math.max(balance, 0), risk: totals.missing > 0 ? 2 : 1, details: totals });
    return { order: (await getOrderTx(c, o.order_ref))!, unpaidWrittenOffCents: Math.max(balance, 0), customerCreditCents: Math.max(-balance, 0) };
  });
}
