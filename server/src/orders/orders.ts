import type pg from 'pg';
import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { accountBalance, cr, dr, postEntryTx, reverseEntryTx } from '../ledger/ledger.js';
import { allocateOrderRef, resolveOrderRef } from '../ledger/refs.js';
import { organizationStanding } from '../couriers/organizations.js';
import { ensureCustomer } from '../customers/customers.js';
import { lockAndCheck, needs, postMovements, resolveLines } from '../stock/stock.js';

export interface OrderCtx {
  pool: Pool;
  /** ORDER_REF_KEY. Needed to issue new references. */
  refKey: string;
}

export type OrderStatus = 'awaiting_dispatch' | 'dispatched' | 'delivered' | 'returning' | 'cancelled';
export type DeliveryOutcome = 'delivered' | 'not_claimed' | 'refused' | 'rescheduled';

export interface OrderItemInput {
  sku?: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  discountCents?: number;
}

export interface CreateOrderInput {
  customerName: string;
  customerPhone: string;
  items: OrderItemInput[];
  /** Sale-wide discount, on top of line discounts. Cannot exceed the sale value. */
  discountCents?: number;
  notes?: string;
  assignedTo?: string;
  actor: string;
  /** An existing order's old code (e.g. UT000123) to keep as a permanent alias. */
  legacyRef?: string;
}

/** Last nine digits, so 0712 345 678, +254712345678 and 712345678 are the same customer. */
export function normalizePhone(phone: string): string {
  const digits = String(phone).replace(/\D/g, '');
  return digits.slice(-9);
}

async function addEvent(db: Queryable, order: { id: number; order_ref: string }, type: string, actor: string, data: Record<string, unknown> = {}) {
  await db.query(`INSERT INTO order_events (order_id, order_ref, type, data, actor) VALUES ($1, $2, $3, $4, $5)`,
    [order.id, order.order_ref, type, JSON.stringify(data), actor]);
}

/**
 * Creates an order: allocates its permanent reference, stores it and its lines, logs the event, and books the
 * amount owed to the ledger (customer receivable / sales), all in one transaction. A discount can never exceed its
 * line or the sale, and a phone number can have only one active order at a time.
 */
export async function createOrder(ctx: OrderCtx, input: CreateOrderInput): Promise<OrderView> {
  const prepared = prepareOrder(input);
  return withTransaction(ctx.pool, (c) => createOrderTx(c, ctx.refKey, input, prepared));
}

export interface PreparedOrder {
  phone: string;
  lines: { sku?: string; name: string; quantity: number; unitPriceCents: number; discount: number; lineTotal: number }[];
  subtotal: number; saleDiscount: number; total: number;
}

/** Checks everything that can be checked without the database. Throws a 422 naming the problem. */
export function prepareOrder(input: CreateOrderInput): PreparedOrder {
  const { items } = input;
  if (!input.customerName?.trim()) throw new HttpError(422, 'ORDER_NO_CUSTOMER', 'A customer name is required.');
  const phone = normalizePhone(input.customerPhone ?? '');
  if (phone.length < 7) throw new HttpError(422, 'ORDER_BAD_PHONE', 'A valid phone number is required.');
  if (!input.actor?.trim()) throw new HttpError(422, 'ORDER_NO_ACTOR', 'The person creating the order is required.');
  if (!Array.isArray(items) || items.length === 0) throw new HttpError(422, 'ORDER_NO_ITEMS', 'An order needs at least one item.');

  let subtotal = 0;
  const lines = items.map((i) => {
    const discount = i.discountCents ?? 0;
    for (const [label, v] of [['quantity', i.quantity], ['unit price', i.unitPriceCents], ['discount', discount]] as const) {
      if (!Number.isSafeInteger(v) || v < 0) throw new HttpError(422, 'ORDER_BAD_AMOUNT', `"${i.name}": ${label} must be a whole non-negative number.`);
    }
    if (i.quantity < 1) throw new HttpError(422, 'ORDER_BAD_AMOUNT', `"${i.name}": quantity must be at least 1.`);
    const gross = i.unitPriceCents * i.quantity;
    if (discount > gross) throw new HttpError(422, 'DISCOUNT_EXCEEDS_LINE', `Discount on "${i.name}" cannot be more than the line value.`);
    subtotal += gross - discount;
    return { ...i, discount, lineTotal: gross - discount };
  });
  const saleDiscount = input.discountCents ?? 0;
  if (!Number.isSafeInteger(saleDiscount) || saleDiscount < 0) throw new HttpError(422, 'ORDER_BAD_AMOUNT', 'Discount must be a whole non-negative number.');
  if (saleDiscount > subtotal) throw new HttpError(422, 'DISCOUNT_EXCEEDS_SALE', 'The discount cannot be more than the sale value.');
  const total = subtotal - saleDiscount;
  if (total <= 0) throw new HttpError(422, 'ORDER_TOTAL_NOT_POSITIVE', 'An order must have something to pay.');
  return { phone, lines, subtotal, saleDiscount, total };
}

/**
 * The transactional part of creating an order, so other flows (converting a lead) can do it inside their own transaction.
 * Stock is checked first: a tracked item needs enough that is neither sold nor already promised to another order.
 */
export async function createOrderTx(c: pg.PoolClient, refKey: string, input: CreateOrderInput, prepared: PreparedOrder): Promise<OrderView> {
  const { phone, lines, subtotal, saleDiscount, total } = prepared;
  const resolved = await resolveLines(c, lines);
  await lockAndCheck(c, needs(lines, resolved), 'available');
  const customerId = await ensureCustomer(c, { name: input.customerName, phone: input.customerPhone, actor: input.actor.trim() });

  const ref = await allocateOrderRef(c, { key: refKey, legacyRef: input.legacyRef });
  let order: { id: number; order_ref: string };
  // A savepoint, because a failed INSERT poisons the whole transaction until it is rolled back to a known point;
  // without it, looking up the existing order below would itself fail.
  await c.query('SAVEPOINT insert_order');
  try {
    const { rows } = await c.query<{ id: number; order_ref: string }>(
      `INSERT INTO orders (order_ref, customer_name, customer_phone, phone_normalized, subtotal_cents, discount_cents, total_cents, notes, assigned_to, created_by, customer_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, order_ref`,
      [ref.ref, input.customerName.trim(), input.customerPhone.trim(), phone, subtotal, saleDiscount, total, input.notes ?? null, input.assignedTo ?? null, input.actor.trim(), customerId]);
    order = rows[0]!;
  } catch (err) {
    if ((err as { code?: string; constraint?: string }).constraint === 'orders_one_active_per_phone') {
      await c.query('ROLLBACK TO SAVEPOINT insert_order');
      const existing = await c.query<{ order_ref: string }>(
        `SELECT order_ref FROM orders WHERE phone_normalized = $1 AND status IN ('awaiting_dispatch', 'dispatched')`, [phone]);
      throw new HttpError(409, 'DUPLICATE_ACTIVE_ORDER', 'This phone number already has an active order.', { existingOrderRef: existing.rows[0]?.order_ref });
    }
    throw err;
  }

  for (const [idx, l] of lines.entries()) {
    await c.query(
      `INSERT INTO order_items (order_id, sku, name, quantity, unit_price_cents, discount_cents, line_total_cents, product_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [order.id, l.sku ?? null, l.name.trim(), l.quantity, l.unitPriceCents, l.discount, l.lineTotal, resolved[idx]!.productId]);
  }
  await postEntryTx(c, {
    description: `Order ${ref.ref} created`, actor: input.actor, orderRef: ref.ref,
    idempotencyKey: `order-created:${ref.ref}`,
    lines: [dr('CUSTOMER_RECEIVABLE', total), cr('SALES', total)],
  });
  await addEvent(c, order, 'created', input.actor, { total_cents: total, items: lines.length });
  return (await getOrderTx(c, ref.ref))!;
}

export interface OrderView {
  id: number;
  orderRef: string;
  status: OrderStatus;
  customerName: string;
  customerPhone: string;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  /** What the customer still owes: the order's customer-receivable balance in the ledger. */
  balanceCents: number;
  /** What has been paid against this order: receipted payments plus money collected by an organization. Derived, never a stored counter (Rule 2). */
  paidCents: number;
  /** Of the paid amount, what an organization collected and has not yet remitted (not yet in the shop's hands). */
  collectedByOrganizationCents: number;
  /** Who it was dispatched with and the package fee entered for it; null until dispatch. */
  dispatch: { courierId: number; courierName: string; packageFeeCents: number; zeroReason: string | null } | null;
  paymentStatus: 'unpaid' | 'part_paid' | 'paid' | 'cancelled';
  items: { id: number; sku: string | null; name: string; quantity: number; unitPriceCents: number; discountCents: number; lineTotalCents: number }[];
  attempts: { attemptNo: number; outcome: DeliveryOutcome; reason: string | null; rescheduleFor: string | null; recordedAt: Date }[];
  events: { type: string; actor: string; at: Date; data: Record<string, unknown> }[];
  createdAt: Date;
  dispatchedAt: Date | null;
  deliveredAt: Date | null;
}

interface OrderRow {
  id: number; order_ref: string; status: OrderStatus; customer_name: string; customer_phone: string;
  subtotal_cents: number; discount_cents: number; total_cents: number;
  created_at: Date; dispatched_at: Date | null; delivered_at: Date | null;
}

export async function getOrderTx(db: Queryable, orderRef: string): Promise<OrderView | null> {
  const o = await db.query<OrderRow>(`SELECT * FROM orders WHERE order_ref = $1`, [orderRef]);
  const r = o.rows[0];
  if (!r) return null;
  const [items, attempts, events, paid, orgPaid, fee, balance] = await Promise.all([
    db.query(`SELECT id, sku, name, quantity, unit_price_cents, discount_cents, line_total_cents FROM order_items WHERE order_id = $1 ORDER BY id`, [r.id]),
    db.query(`SELECT attempt_no, outcome, reason, to_char(reschedule_for, 'YYYY-MM-DD') AS reschedule_for, recorded_at FROM delivery_attempts WHERE order_id = $1 ORDER BY attempt_no`, [r.id]),
    db.query(`SELECT type, actor, at, data FROM order_events WHERE order_id = $1 ORDER BY id`, [r.id]),
    db.query<{ s: number }>(`SELECT COALESCE(sum(amount_cents), 0)::bigint AS s FROM payment_receipts WHERE order_ref = $1`, [orderRef]),
    db.query<{ s: number }>(`SELECT COALESCE(sum(amount_cents), 0)::bigint AS s FROM org_collections WHERE order_ref = $1`, [orderRef]),
    db.query<{ courier_id: number; name: string; amount_cents: number; zero_reason: string | null }>(
      `SELECT f.courier_id, c.name, f.amount_cents, f.zero_reason FROM package_fees f JOIN couriers c ON c.id = f.courier_id WHERE f.order_id = $1`, [r.id]),
    accountBalance(db, 'CUSTOMER_RECEIVABLE', { orderRef }),
  ]);
  const paidCents = paid.rows[0]!.s + orgPaid.rows[0]!.s;
  const paymentStatus = r.status === 'cancelled' ? 'cancelled' : paidCents === 0 ? 'unpaid' : balance === 0 ? 'paid' : 'part_paid';
  return {
    id: r.id, orderRef: r.order_ref, status: r.status, customerName: r.customer_name, customerPhone: r.customer_phone,
    subtotalCents: r.subtotal_cents, discountCents: r.discount_cents, totalCents: r.total_cents,
    balanceCents: balance, paidCents, collectedByOrganizationCents: orgPaid.rows[0]!.s, paymentStatus,
    dispatch: fee.rows[0] ? { courierId: fee.rows[0].courier_id, courierName: fee.rows[0].name, packageFeeCents: fee.rows[0].amount_cents, zeroReason: fee.rows[0].zero_reason } : null,
    items: items.rows.map((i) => ({ id: i.id, sku: i.sku, name: i.name, quantity: i.quantity, unitPriceCents: i.unit_price_cents, discountCents: i.discount_cents, lineTotalCents: i.line_total_cents })),
    attempts: attempts.rows.map((a) => ({ attemptNo: a.attempt_no, outcome: a.outcome, reason: a.reason, rescheduleFor: a.reschedule_for, recordedAt: a.recorded_at })),
    events: events.rows.map((e) => ({ type: e.type, actor: e.actor, at: e.at, data: e.data })),
    createdAt: r.created_at, dispatchedAt: r.dispatched_at, deliveredAt: r.delivered_at,
  };
}

/** Looks an order up by whatever was typed: new reference in any case/spacing, or an old UTnnnnnn code. */
export async function findOrder(db: Queryable, typedRef: string): Promise<OrderView | null> {
  const ref = await resolveOrderRef(db, typedRef);
  return ref ? getOrderTx(db, ref.ref) : null;
}

// Locks the order row for the length of the transaction, so two people acting on one order are processed one at a time.
async function lockOrder(c: pg.PoolClient, typedRef: string): Promise<OrderRow> {
  const ref = await resolveOrderRef(c, typedRef);
  const { rows } = ref ? await c.query<OrderRow>(`SELECT * FROM orders WHERE order_ref = $1 FOR UPDATE`, [ref.ref]) : { rows: [] };
  if (!rows[0]) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  return rows[0];
}

function requireActor(actor: string): void {
  if (!actor?.trim()) throw new HttpError(422, 'ORDER_NO_ACTOR', 'The person making this change is required.');
}

const wrongState = (o: OrderRow, action: string) =>
  new HttpError(409, 'ORDER_WRONG_STATE', `An order that is ${o.status.replace('_', ' ')} cannot be ${action}.`);

/**
 * Dispatches an order with a courier, and records the package fee for the dispatch in the same transaction. A dispatch
 * cannot complete without a fee line; a zero fee needs a reason (Rule 11). The fee is owed from this moment, whether or
 * not the customer claims the parcel. Staff enter the amount by hand: there is no default fee.
 */
export async function dispatchOrder(ctx: OrderCtx, input: {
  orderRef: string; actor: string; courierId: number;
  packageFee: { amountCents: number; zeroReason?: string };
}): Promise<OrderView> {
  requireActor(input.actor);
  if (!Number.isSafeInteger(input.courierId)) throw new HttpError(422, 'DISPATCH_NEEDS_COURIER', 'Choose the rider or organization this is being dispatched with.');
  const fee = input.packageFee;
  if (!fee || !Number.isSafeInteger(fee.amountCents) || fee.amountCents < 0) {
    throw new HttpError(422, 'DISPATCH_NEEDS_FEE', 'Enter the package fee for this dispatch. A dispatch cannot complete without one.');
  }
  if (fee.amountCents === 0 && !fee.zeroReason?.trim()) {
    throw new HttpError(422, 'FEE_ZERO_NEEDS_REASON', 'A zero package fee needs a reason.');
  }
  return withTransaction(ctx.pool, async (c) => {
    const o = await lockOrder(c, input.orderRef);
    if (o.status !== 'awaiting_dispatch') throw wrongState(o, 'dispatched');

    const courier = await c.query<{ id: number; name: string; active: boolean; kind: string; collects_payment: boolean }>(
      `SELECT id, name, active, kind, collects_payment FROM couriers WHERE id = $1`, [input.courierId]);
    const cur = courier.rows[0];
    if (!cur) throw new HttpError(404, 'COURIER_NOT_FOUND', 'Courier not found.');
    if (!cur.active) throw new HttpError(409, 'COURIER_INACTIVE', `${cur.name} is deactivated and cannot take new dispatches.`);
    if (cur.kind === 'organization' && cur.collects_payment) {
      const standing = await organizationStanding(c, cur.id);
      if (standing.paused) {
        throw new HttpError(409, 'ORG_PAUSED', `${cur.name} has overdue balances above its limit. New collect-on-delivery parcels are paused until it remits.`,
          { overdueCents: standing.overdueCents, limitCents: standing.limitCents });
      }
    }

    // A customer flagged as prepay-only must have paid in full before anything leaves.
    const flag = await c.query<{ prepay_required: boolean }>(`SELECT cu.prepay_required FROM orders o JOIN customers cu ON cu.id = o.customer_id WHERE o.id = $1`, [o.id]);
    if (flag.rows[0]?.prepay_required && (await accountBalance(c, 'CUSTOMER_RECEIVABLE', { orderRef: o.order_ref })) > 0) {
      throw new HttpError(409, 'PREPAY_REQUIRED', 'This customer must pay in full before dispatch, and this order is not fully paid yet.');
    }
    // The goods leave stock now. Refused if there is not enough physically there.
    const goods = await c.query<{ product_id: number; q: number }>(
      `SELECT i.product_id, sum(i.quantity)::int AS q FROM order_items i JOIN products p ON p.id = i.product_id
        WHERE i.order_id = $1 AND p.track_stock GROUP BY i.product_id ORDER BY i.product_id`, [o.id]);
    await lockAndCheck(c, new Map(goods.rows.map((g) => [g.product_id, g.q])), 'on_hand');
    await postMovements(c, goods.rows.map((g) => ({ productId: g.product_id, type: 'dispatch' as const, quantity: -g.q, actor: input.actor.trim(), ref: { type: 'order' as const, id: o.id } })));

    let entryId: number | null = null;
    if (fee.amountCents > 0) {
      const { entry } = await postEntryTx(c, {
        description: `Package fee for ${o.order_ref}`, actor: input.actor, orderRef: o.order_ref, courierId: cur.id,
        idempotencyKey: `package-fee:${o.order_ref}`,
        lines: [dr('COURIER_PACKAGE_FEES', fee.amountCents), cr('COURIER_PAYABLE', fee.amountCents)],
      });
      entryId = entry.id;
    }
    await c.query(
      `INSERT INTO package_fees (order_id, order_ref, courier_id, amount_cents, zero_reason, entry_id, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [o.id, o.order_ref, cur.id, fee.amountCents, fee.amountCents === 0 ? fee.zeroReason!.trim() : null, entryId, input.actor.trim()]);
    await c.query(`UPDATE orders SET status = 'dispatched', dispatched_at = now(), updated_at = now() WHERE id = $1`, [o.id]);
    await addEvent(c, o, 'dispatched', input.actor, { courier_id: cur.id, courier: cur.name, package_fee_cents: fee.amountCents });
    return (await getOrderTx(c, o.order_ref))!;
  });
}

export async function cancelOrder(ctx: OrderCtx, input: { orderRef: string; reason: string; actor: string }): Promise<OrderView> {
  requireActor(input.actor);
  if (!input.reason?.trim()) throw new HttpError(422, 'ORDER_REASON_REQUIRED', 'A reason is required to cancel an order.');
  return withTransaction(ctx.pool, async (c) => {
    const o = await lockOrder(c, input.orderRef);
    if (o.status !== 'awaiting_dispatch') throw wrongState(o, 'cancelled');
    const paid = await c.query<{ s: number }>(`SELECT COALESCE(sum(amount_cents), 0)::bigint AS s FROM payment_receipts WHERE order_ref = $1`, [o.order_ref]);
    if (paid.rows[0]!.s > 0) {
      throw new HttpError(409, 'ORDER_HAS_PAYMENTS', 'This order has payments. Refund them through suspense first; an order with money on it cannot simply be cancelled.');
    }
    await c.query(`UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1`, [o.id]);
    await addEvent(c, o, 'cancelled', input.actor, { reason: input.reason.trim() });
    // The amount owed comes back off the ledger with an exact reversing entry (never an edit), in the same
    // transaction as the status change: either both happen or neither does.
    const created = await c.query<{ id: number }>(`SELECT id FROM journal_entries WHERE idempotency_key = $1`, [`order-created:${o.order_ref}`]);
    await reverseEntryTx(c, { entryId: created.rows[0]!.id, reason: `Order cancelled: ${input.reason.trim()}`, actor: input.actor });
    return (await getOrderTx(c, o.order_ref))!;
  });
}

/**
 * Records one delivery attempt. Every attempt is kept. Delivered completes the order; rescheduled keeps it out for
 * delivery with a new date; not claimed and refused send it back (returning). A reason is required for anything but delivered.
 */
export async function recordDeliveryAttempt(ctx: OrderCtx, input: {
  orderRef: string; outcome: DeliveryOutcome; reason?: string; rescheduleFor?: string; courierLabel?: string; actor: string;
}): Promise<OrderView> {
  requireActor(input.actor);
  if (input.outcome !== 'delivered' && !input.reason?.trim()) {
    throw new HttpError(422, 'ATTEMPT_REASON_REQUIRED', 'A reason is required unless the order was delivered.');
  }
  if (input.outcome === 'rescheduled' && !/^\d{4}-\d{2}-\d{2}$/.test(input.rescheduleFor ?? '')) {
    throw new HttpError(422, 'ATTEMPT_DATE_REQUIRED', 'A rescheduled attempt needs the new date (YYYY-MM-DD).');
  }
  if (input.outcome !== 'rescheduled' && input.rescheduleFor) {
    throw new HttpError(422, 'ATTEMPT_DATE_UNEXPECTED', 'Only a rescheduled attempt has a new date.');
  }
  return withTransaction(ctx.pool, async (c) => {
    const o = await lockOrder(c, input.orderRef);
    if (o.status !== 'dispatched') throw wrongState(o, 'given a delivery outcome');
    const next = await c.query<{ n: number }>(`SELECT COALESCE(max(attempt_no), 0) + 1 AS n FROM delivery_attempts WHERE order_id = $1`, [o.id]);
    await c.query(
      `INSERT INTO delivery_attempts (order_id, order_ref, attempt_no, outcome, reason, reschedule_for, courier_label, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [o.id, o.order_ref, next.rows[0]!.n, input.outcome, input.reason?.trim() ?? null, input.rescheduleFor ?? null, input.courierLabel ?? null, input.actor]);
    await addEvent(c, o, `delivery_${input.outcome}`, input.actor, { attempt_no: next.rows[0]!.n, reason: input.reason ?? null, reschedule_for: input.rescheduleFor ?? null });

    if (input.outcome === 'delivered') {
      await c.query(`UPDATE orders SET status = 'delivered', delivered_at = now(), updated_at = now() WHERE id = $1`, [o.id]);
    } else if (input.outcome === 'not_claimed' || input.outcome === 'refused') {
      await c.query(`UPDATE orders SET status = 'returning', updated_at = now() WHERE id = $1`, [o.id]);
      await addEvent(c, o, 'returning', input.actor, { because: input.outcome });
    }
    return (await getOrderTx(c, o.order_ref))!;
  });
}
