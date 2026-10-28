import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { createOrderTx, cancelOrder, prepareOrder, type CreateOrderInput } from '../orders/orders.js';
import type { IncomeSource, Platform } from './sources.js';

// What a Shopify or WooCommerce order looks like once both are reduced to the same shape. Ported from the legacy importer,
// with money held as whole cents and never as floats.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = Record<string, any>;
const clean = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());

/** "1500.00", "1,500", 1500.5, "" -> cents; "" and null are 0; anything that is not a number is null (never guessed). */
export function moneyToCents(v: unknown): number | null {
  const s = clean(v).replace(/,/g, '');
  if (s === '') return 0;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const cents = /^\d+(\.\d{1,2})?$/.test(s) ? Math.round(Number(s) * 100) : Math.round(parseFloat(s) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

export interface NormalLine { sku: string | null; title: string; quantity: number; unitPriceCents: number; discountCents: number }
export interface NormalOrder {
  externalId: string; label: string; cancelled: boolean; toShip: boolean; paid: boolean; gateway: string;
  customer: { name: string; phone: string; email: string | null; city: string | null };
  lines: NormalLine[]; note: string | null;
  /** An amount on the order that could not be read. The order is then NOT imported: a wrong total is worse than a person looking. */
  problem?: string;
}

export function normalizeShopify(o: J): NormalOrder {
  const ship = (o.shipping_address ?? {}) as J; const bill = (o.billing_address ?? {}) as J; const cust = (o.customer ?? {}) as J;
  const name = clean(ship.name) || clean(bill.name) || [cust.first_name, cust.last_name].map(clean).filter(Boolean).join(' ');
  const gateway = Array.isArray(o.payment_gateway_names) ? o.payment_gateway_names.join(' ') : '';
  let problem: string | undefined;
  const lines = (Array.isArray(o.line_items) ? o.line_items : []).map((li: J): NormalLine => {
    const price = moneyToCents(li.price); const disc = moneyToCents(li.total_discount);
    if (price === null || disc === null) problem ??= `An amount on "${clean(li.title)}" could not be read.`;
    return { sku: clean(li.sku) || null, title: clean(li.title) || 'Online item', quantity: Math.max(parseInt(li.quantity, 10) || 1, 1), unitPriceCents: price ?? 0, discountCents: disc ?? 0 };
  });
  const paid = o.financial_status === 'paid';
  return {
    externalId: clean(o.id), label: clean(o.name) || `#${clean(o.order_number) || clean(o.id)}`, cancelled: Boolean(o.cancelled_at),
    toShip: !o.cancelled_at && [null, undefined, 'partial', 'unfulfilled'].includes(o.fulfillment_status), paid, gateway,
    customer: { name: name || 'Online customer', phone: clean(ship.phone) || clean(bill.phone) || clean(cust.phone) || clean(o.phone), email: clean(o.email) || clean(cust.email) || null, city: clean(ship.city) || clean(ship.province) || clean(bill.city) || null },
    lines, note: clean(o.note) || null, problem,
  };
}

export function normalizeWoo(o: J): NormalOrder {
  const bill = (o.billing ?? {}) as J; const ship = (o.shipping ?? {}) as J;
  const name = [ship.first_name || bill.first_name, ship.last_name || bill.last_name].map(clean).filter(Boolean).join(' ');
  const gateway = `${clean(o.payment_method)} ${clean(o.payment_method_title)}`.trim();
  let problem: string | undefined;
  const lines = (Array.isArray(o.line_items) ? o.line_items : []).map((li: J): NormalLine => {
    const qty = Math.max(parseInt(li.quantity, 10) || 1, 1);
    const gross = moneyToCents(li.subtotal); const net = moneyToCents(li.total);
    if (gross === null || net === null) problem ??= `An amount on "${clean(li.name)}" could not be read.`;
    const g = gross ?? 0;
    return { sku: clean(li.sku) || null, title: clean(li.name) || 'Online item', quantity: qty, unitPriceCents: Math.round(g / qty), discountCents: Math.max(g - (net ?? g), 0) };
  });
  return {
    externalId: clean(o.id), label: `#${clean(o.number) || clean(o.id)}`, cancelled: ['cancelled', 'refunded', 'failed', 'trash'].includes(o.status),
    toShip: ['pending', 'processing', 'on-hold'].includes(o.status), paid: Boolean(o.date_paid) && o.payment_method !== 'cod', gateway,
    customer: { name: name || 'Online customer', phone: clean(bill.phone) || clean(ship.phone), email: clean(bill.email) || null, city: clean(ship.city) || clean(bill.city) || null },
    lines, note: clean(o.customer_note) || null, problem,
  };
}

export const normalize = (platform: Platform, o: J): NormalOrder => (platform === 'shopify' ? normalizeShopify(o) : normalizeWoo(o));
export const platformLabel = (platform: Platform) => (platform === 'shopify' ? 'Shopify' : 'WooCommerce');

export type ImportOutcome =
  | { action: 'created'; orderRef: string; paidOnline: boolean }
  | { action: 'cancelled'; orderRef: string }
  | { action: 'unchanged'; orderRef: string }
  | { action: 'ignored'; reason: string }
  | { action: 'needs_attention'; orderRef: string; reason: string };

/**
 * One online order, however many times and in whatever order its events arrive. The (connection, store order id) pair is the
 * identity: it is looked up under a lock, and the order and its link are written in ONE transaction, so a crash can never leave an
 * order without its link (which a retry would then turn into a second order).
 *
 *  - not seen before and still to ship  -> becomes an order here (reserving stock, like any order)
 *  - seen before, and now cancelled     -> cancelled here too, if it is still waiting; if it has gone out or has money on it, that
 *                                          is reported for a person instead of being undone behind their back
 *  - anything else                      -> nothing
 * Errors that mean "this order cannot be taken as it stands" (no stock, an active order for the phone, a missing phone) are HttpErrors;
 * the caller keeps the delivery for review. Anything else is the server's fault and is retried.
 */
export async function importOnlineOrder(ctx: { pool: Pool; refKey: string }, source: IncomeSource, raw: J, opts: { deleted?: boolean } = {}): Promise<ImportOutcome> {
  const payload = opts.deleted ? { ...raw, status: 'cancelled' } : raw;
  const norm = normalize(source.platform, payload);
  if (!norm.externalId || norm.externalId === 'undefined') return { action: 'ignored', reason: 'The delivery had no order id.' };
  const actor = source.platform; // 'shopify' | 'woocommerce': who the order is recorded as created by
  const label = platformLabel(source.platform);

  type Step = ImportOutcome | { action: 'cancel_now'; orderRef: string };
  const step: Step = await withTransaction(ctx.pool, async (c): Promise<Step> => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`online-order:${source.id}:${norm.externalId}`]);
    const known = (await c.query<{ order_ref: string }>(`SELECT order_ref FROM online_orders WHERE income_source_id = $1 AND external_order_id = $2`, [source.id, norm.externalId])).rows[0];

    if (known) {
      if (!norm.cancelled) return { action: 'unchanged', orderRef: known.order_ref };
      const status = (await c.query<{ status: string }>(`SELECT status FROM orders WHERE order_ref = $1`, [known.order_ref])).rows[0]?.status;
      if (status === 'cancelled') return { action: 'unchanged', orderRef: known.order_ref };
      if (status !== 'awaiting_dispatch') return { action: 'needs_attention', orderRef: known.order_ref, reason: `${label} order ${norm.label} was cancelled on the store, but ${known.order_ref} is already ${status}.` };
      return { action: 'cancel_now', orderRef: known.order_ref };
    }

    if (!source.importOrders) return { action: 'ignored', reason: 'This connection does not import orders.' };
    if (norm.cancelled || !norm.toShip) return { action: 'ignored', reason: 'Not waiting to be shipped (already fulfilled or cancelled on the store).' };
    if (norm.problem) throw new HttpError(422, 'ONLINE_ORDER_UNREADABLE', `${label} order ${norm.label}: ${norm.problem}`);
    if (!norm.customer.phone) throw new HttpError(422, 'ONLINE_ORDER_NO_PHONE', `${label} order ${norm.label} has no phone number; the shop cannot deliver without one.`);
    if (norm.lines.length === 0) throw new HttpError(422, 'ONLINE_ORDER_NO_ITEMS', `${label} order ${norm.label} has no items.`);

    const note = `Imported from ${label} order ${norm.label}${norm.paid ? ` - PAID ONLINE (${norm.gateway || 'gateway'}): record the payment before dispatch` : ''}${norm.note ? ` - customer note: ${norm.note}` : ''}`;
    const input: CreateOrderInput = {
      customerName: norm.customer.name, customerPhone: norm.customer.phone, notes: note, actor,
      items: norm.lines.map((l) => ({ ...(l.sku ? { sku: l.sku } : {}), name: l.title, quantity: l.quantity, unitPriceCents: l.unitPriceCents, discountCents: Math.min(l.discountCents, l.unitPriceCents * l.quantity) })),
    };
    const order = await createOrderTx(c, ctx.refKey, input, prepareOrder(input));
    await c.query(`INSERT INTO online_orders (income_source_id, external_order_id, label, order_ref, paid_online, gateway) VALUES ($1, $2, $3, $4, $5, $6)`,
      [source.id, norm.externalId, norm.label, order.orderRef, norm.paid, norm.gateway || null]);
    await c.query(`INSERT INTO order_events (order_id, order_ref, type, data, actor) VALUES ((SELECT id FROM orders WHERE order_ref = $1), $1, 'imported_online', $2, $3)`,
      [order.orderRef, JSON.stringify({ platform: source.platform, source: source.id, externalId: norm.externalId, label: norm.label, paidOnline: norm.paid }), actor]);
    return { action: 'created', orderRef: order.orderRef, paidOnline: norm.paid };
  });
  if (step.action !== 'cancel_now') return step;

  // Cancelling is its own transaction (it reverses the ledger entry), so it runs after the one above has let go of its connection and
  // its lock; holding one connection while waiting for a second is how a busy pool deadlocks itself.
  const orderRef = step.orderRef;
  try {
    await cancelOrder({ pool: ctx.pool, refKey: ctx.refKey }, { orderRef, reason: `Cancelled on the online store (${label} ${norm.label}) before dispatch.`, actor });
    return { action: 'cancelled', orderRef };
  } catch (err) {
    if (err instanceof HttpError && err.code === 'ORDER_HAS_PAYMENTS') return { action: 'needs_attention', orderRef, reason: `${label} order ${norm.label} was cancelled on the store, but ${orderRef} already has money on it: refund it first.` };
    if (err instanceof HttpError) {
      // Another copy of the same cancellation got there first, or the order moved on in the meantime. Say what is true now.
      const now = (await ctx.pool.query<{ status: string }>(`SELECT status FROM orders WHERE order_ref = $1`, [orderRef])).rows[0]?.status;
      if (now === 'cancelled') return { action: 'unchanged', orderRef };
      return { action: 'needs_attention', orderRef, reason: `${label} order ${norm.label} was cancelled on the store, but ${orderRef} is now ${now ?? 'unknown'}.` };
    }
    throw err;
  }
}
