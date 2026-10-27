import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { dateStr, flag, handler, paging, parse, who } from '../http.js';
import { depositCustody, listOpenCustody } from '../orders/custody.js';
import { listOrders } from '../orders/list.js';
import { assertReadyToDispatch, cancelOrder, confirmOrder, createOrder, dispatchOrder, findOrder, recordDeliveryAttempt, type OrderCtx, type OrderStatus } from '../orders/orders.js';
import { applySuspenseToOrder, listSuspense, recordShopCash, refundSuspense, suggestMatches } from '../orders/payments.js';
import { moneyAtRisk } from '../orders/atRisk.js';
import { receiveReturnedOrder } from '../orders/returns.js';
import { addItemsToOrder } from '../orders/merge.js';
import { idParam } from '../http.js';

const cents = z.number().int().min(0);
const item = z.object({ sku: z.string().max(40).optional(), name: z.string().min(1).max(200), quantity: z.number().int().min(1), unitPriceCents: cents, discountCents: cents.optional() });
const createBody = z.object({
  customerName: z.string().min(1).max(150), customerPhone: z.string().min(1).max(30), items: z.array(item).min(1), discountCents: cents.optional(),
  notes: z.string().max(500).optional(), assignedTo: z.string().max(64).optional(), legacyRef: z.string().max(30).optional(),
});
const dispatchBody = z.object({ courierId: z.number().int().positive(), packageFee: z.object({ amountCents: cents, zeroReason: z.string().max(300).optional() }) });
const cancelBody = z.object({ reason: z.string().min(1).max(300) });
const attemptBody = z.object({ outcome: z.enum(['delivered', 'not_claimed', 'refused', 'rescheduled']), reason: z.string().max(300).optional(), rescheduleFor: dateStr.optional(), courierLabel: z.string().max(100).optional() });
const returnBody = z.object({ items: z.array(z.object({ orderItemId: z.number().int().positive(), restockQuantity: z.number().int().min(0), damagedQuantity: z.number().int().min(0).optional() })).min(1), notes: z.string().max(500).optional() });
const addItemsBody = z.object({ items: z.array(item).min(1) });
const cashBody = z.object({ amountCents: z.number().int().positive(), reason: z.string().min(1).max(300) });
const applyBody = z.object({ orderRef: z.string().min(1).max(30) });
const refundBody = z.object({ amountCents: z.number().int().positive().optional(), reason: z.string().min(1).max(300) });

export function ordersRouter(pool: Pool, opts: { orderRefKey?: string }): Router {
  const r = Router();
  r.use(requireAuth(pool));
  const ctx = (): OrderCtx => {
    if (!opts.orderRefKey) throw new HttpError(503, 'ORDER_REF_KEY_MISSING', 'Order references are not configured on this server (ORDER_REF_KEY).');
    return { pool, refKey: opts.orderRefKey };
  };

  // ---------------------------------------------------------------- money that needs a person: the specific paths come first
  r.get('/payments/suspense', requirePermission('payments.match'), handler(async (_req, res) => { res.json({ items: await listSuspense(pool) }); }));
  r.get('/payments/suspense/:id/suggestions', requirePermission('payments.match'), handler(async (req, res) => {
    res.json({ suggestions: await suggestMatches(pool, idParam(req.params.id)) });
  }));
  r.post('/payments/suspense/:id/apply', requirePermission('payments.match'), handler(async (req, res) => {
    res.json(await applySuspenseToOrder({ pool }, { exceptionId: idParam(req.params.id), ...parse(applyBody, req.body), actor: req.user!.username }));
  }));
  r.post('/payments/suspense/:id/refund', requirePermission('payments.match'), handler(async (req, res) => {
    res.json(await refundSuspense({ pool }, { exceptionId: idParam(req.params.id), ...parse(refundBody, req.body), actor: req.user!.username }));
  }));
  r.get('/custody', requirePermission('payments.match'), handler(async (_req, res) => { res.json({ records: await listOpenCustody(pool) }); }));
  r.post('/custody/:id/deposit', requirePermission('payments.match'), handler(async (req, res) => {
    res.json(await depositCustody({ pool }, { custodyId: idParam(req.params.id), actor: req.user!.username }));
  }));

  r.get('/at-risk', requirePermission('atrisk.view'), handler(async (req, res) => {
    const n = (v: unknown) => (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
    const q = req.query;
    const items = await moneyAtRisk(pool, { dispatchedNoOutcomeDays: n(q.dispatchedNoOutcomeDays), deliveredUnpaidDays: n(q.deliveredUnpaidDays), returningDays: n(q.returningDays),
      courierUnpaidDays: n(q.courierUnpaidDays), cashHeldDays: n(q.cashHeldDays), sessionOpenHours: n(q.sessionOpenHours) });
    res.json({ items, totalCents: items.reduce((s, i) => s + i.amountCents, 0) });
  }));

  // ---------------------------------------------------------------- orders
  r.get('/orders', requirePermission('orders.view'), handler(async (req, res) => {
    const q = req.query;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const known = ['awaiting_dispatch', 'dispatched', 'delivered', 'returning', 'returned', 'cancelled'];
    const many = str(q.status)?.includes(',') ? str(q.status)!.split(',').map((x) => x.trim()).filter((x) => known.includes(x)) as OrderStatus[] : undefined;
    res.json(await listOrders(pool, { status: many ? undefined : str(q.status) as OrderStatus | 'active' | undefined, statuses: many, returnProblem: flag(q.returnProblem), search: str(q.search), assignedTo: str(q.assignedTo), unpaidOnly: flag(q.unpaid) === true, paymentStatus: (['unpaid', 'part_paid', 'paid'] as const).find((p) => p === q.paymentStatus), ...paging(q) }));
  }));

  r.get('/orders/:ref', requirePermission('orders.view'), handler(async (req, res) => {
    const o = await findOrder(pool, String(req.params.ref));
    if (!o) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    res.json({ order: o });
  }));

  r.post('/orders', requirePermission('orders.create'), handler(async (req, res) => {
    res.status(201).json({ order: await createOrder(ctx(), { ...parse(createBody, req.body), actor: req.user!.username }) });
  }));

  // "Confirm with customer": the call that must happen before an unpaid order can leave the shop.
  r.post('/orders/:ref/confirm', requirePermission('orders.manage'), handler(async (req, res) => {
    res.json({ order: await confirmOrder(ctx(), { orderRef: String(req.params.ref), actor: req.user!.username }) });
  }));

  // Items added to an order still waiting to leave the shop (the merge when a phone number already has an active order).
  r.post('/orders/:ref/items', requirePermission('orders.manage'), handler(async (req, res) => {
    res.json({ order: await addItemsToOrder({ pool }, { orderRef: String(req.params.ref), ...parse(addItemsBody, req.body), ...who(req) }) });
  }));

  r.post('/orders/:ref/dispatch', requirePermission('orders.manage'), handler(async (req, res) => {
    await assertReadyToDispatch(pool, String(req.params.ref));
    res.json({ order: await dispatchOrder(ctx(), { orderRef: String(req.params.ref), ...parse(dispatchBody, req.body), actor: req.user!.username }) });
  }));

  r.post('/orders/:ref/cancel', requirePermission('orders.manage'), handler(async (req, res) => {
    res.json({ order: await cancelOrder(ctx(), { orderRef: String(req.params.ref), ...parse(cancelBody, req.body), actor: req.user!.username }) });
  }));

  r.post('/orders/:ref/attempts', requirePermission('orders.manage'), handler(async (req, res) => {
    res.status(201).json({ order: await recordDeliveryAttempt(ctx(), { orderRef: String(req.params.ref), ...parse(attemptBody, req.body), actor: req.user!.username }) });
  }));

  // The parcel of a failed delivery is physically back: count it in, line by line.
  r.post('/orders/:ref/returned', requirePermission('orders.manage'), handler(async (req, res) => {
    res.json(await receiveReturnedOrder({ pool }, { orderRef: String(req.params.ref), ...parse(returnBody, req.body), ...who(req) }));
  }));

  // Cash taken over the counter against an order: an exception, so a manager does it and gives a reason.
  r.post('/orders/:ref/shop-cash', requirePermission('payments.match'), handler(async (req, res) => {
    res.status(201).json(await recordShopCash({ pool }, { orderRef: String(req.params.ref), ...parse(cashBody, req.body), actor: req.user!.username }));
  }));

  return r;
}
