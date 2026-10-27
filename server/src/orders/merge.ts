import { withTransaction } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { cr, dr, postEntryTx } from '../ledger/ledger.js';
import { lockAndCheck, needs, resolveLines } from '../stock/stock.js';
import { audit } from '../pos/audit.js';
import { resolveOrderRef } from '../ledger/refs.js';
import { getOrderTx, type OrderItemInput, type OrderView } from './orders.js';

/**
 * Adds items to an order that has not left the shop (the legacy "merge items", and the one-tap merge when a phone number
 * already has an active order). The order keeps its reference. The added value is booked as its own receivable/sales entry
 * (never an edit of the first one), the stock for the new items is checked against what is free, and the change is an event.
 * Only an order that is still awaiting dispatch can grow: after that, what is in the parcel is what was agreed.
 */
export async function addItemsToOrder(
  ctx: { pool: import('../db/pool.js').Pool },
  input: { orderRef: string; items: OrderItemInput[]; actor: string; role?: string },
): Promise<OrderView> {
  if (!input.actor?.trim()) throw new HttpError(422, 'ORDER_NO_ACTOR', 'The person making this change is required.');
  if (!Array.isArray(input.items) || input.items.length === 0) throw new HttpError(422, 'ORDER_NO_ITEMS', 'Add at least one item.');

  let added = 0;
  const lines = input.items.map((i) => {
    const discount = i.discountCents ?? 0;
    for (const [label, v] of [['quantity', i.quantity], ['unit price', i.unitPriceCents], ['discount', discount]] as const) {
      if (!Number.isSafeInteger(v) || v < 0) throw new HttpError(422, 'ORDER_BAD_AMOUNT', `"${i.name}": ${label} must be a whole non-negative number.`);
    }
    if (i.quantity < 1) throw new HttpError(422, 'ORDER_BAD_AMOUNT', `"${i.name}": quantity must be at least 1.`);
    const gross = i.unitPriceCents * i.quantity;
    if (discount > gross) throw new HttpError(422, 'DISCOUNT_EXCEEDS_LINE', `Discount on "${i.name}" cannot be more than the line value.`);
    added += gross - discount;
    return { ...i, discount, lineTotal: gross - discount };
  });
  if (added <= 0) throw new HttpError(422, 'ORDER_TOTAL_NOT_POSITIVE', 'The items added must have something to pay.');

  return withTransaction(ctx.pool, async (c) => {
    const ref = await resolveOrderRef(c, input.orderRef);
    const { rows } = ref ? await c.query<{ id: number; order_ref: string; status: string }>(`SELECT id, order_ref, status FROM orders WHERE order_ref = $1 FOR UPDATE`, [ref.ref]) : { rows: [] };
    const o = rows[0];
    if (!o) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    if (o.status !== 'awaiting_dispatch') {
      throw new HttpError(409, 'ORDER_WRONG_STATE', `Items can only be added to an order that is awaiting dispatch, not one that is ${o.status.replace('_', ' ')}.`);
    }

    const resolved = await resolveLines(c, lines);
    await lockAndCheck(c, needs(lines, resolved), 'available');

    for (const [idx, l] of lines.entries()) {
      await c.query(
        `INSERT INTO order_items (order_id, sku, name, quantity, unit_price_cents, discount_cents, line_total_cents, product_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [o.id, l.sku ?? null, l.name.trim(), l.quantity, l.unitPriceCents, l.discount, l.lineTotal, resolved[idx]!.productId]);
    }

    // The nth merge of this order. The order row is locked, so two merges can never take the same number.
    const n = (await c.query<{ n: number }>(`SELECT count(*)::int + 1 AS n FROM order_events WHERE order_id = $1 AND type = 'items_added'`, [o.id])).rows[0]!.n;
    await postEntryTx(c, {
      description: `Order ${o.order_ref}: items added (${n})`, actor: input.actor, orderRef: o.order_ref,
      idempotencyKey: `order-items-added:${o.order_ref}:${n}`,
      lines: [dr('CUSTOMER_RECEIVABLE', added), cr('SALES', added)],
    });
    await c.query(`UPDATE orders SET subtotal_cents = subtotal_cents + $2, total_cents = total_cents + $2, updated_at = now() WHERE id = $1`, [o.id, added]);
    await c.query(`INSERT INTO order_events (order_id, order_ref, type, data, actor) VALUES ($1, $2, 'items_added', $3, $4)`,
      [o.id, o.order_ref, JSON.stringify({ added_cents: added, items: lines.length, names: lines.map((l) => l.name.trim()) }), input.actor.trim()]);
    await audit(c, { actor: input.actor, role: input.role, action: 'order_items_added', entityType: 'order', entityId: o.order_ref, amountCents: added, risk: 1, details: { items: lines.length } });
    return (await getOrderTx(c, o.order_ref))!;
  });
}
