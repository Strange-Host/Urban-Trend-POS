import { Router } from 'express';
import { z } from 'zod';
import { approverFrom } from '../auth/approval.js';
import { requireAuth, requirePermission } from '../auth/middleware.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { handler, idParam, paging, parse } from '../http.js';
import { addDiscountReason, listDiscountReasons, setDiscountPolicy, setDiscountReasonActive } from '../pos/policy.js';
import { listAudit, listPolicies, listSales, listSessions } from '../pos/lists.js';
import { checkout, getSale, refundSale, voidSale } from '../pos/sales.js';
import { closeSession, expectedByMethod, getOpenSession, getSession, openSession, recordCashMovement, signOffSession } from '../pos/sessions.js';

const cents = z.number().int().min(0);
const method = z.enum(['cash', 'card', 'mobile_money']);
const approval = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) });
const item = z.object({ sku: z.string().max(40).optional(), name: z.string().min(1).max(200), quantity: z.number().int().min(1), unitPriceCents: cents, discountCents: cents.optional() });
const checkoutBody = z.object({
  items: z.array(item).min(1), saleDiscountCents: cents.optional(), discountReason: z.string().max(60).optional(),
  payments: z.array(z.object({ method, amountCents: z.number().int().positive(), reference: z.string().max(100).optional() })).min(1),
  clientSaleId: z.string().max(100).optional(), approval: approval.optional(),
});
const voidBody = z.object({ reason: z.string().min(1).max(300), approval });
const refundBody = z.object({
  items: z.array(z.object({ saleItemId: z.number().int().positive(), quantity: z.number().int().min(1) })).min(1), method, reason: z.string().min(1).max(300), restock: z.boolean().optional(), approval,
});
const openBody = z.object({ openingFloatCents: cents });
const movementBody = z.object({ kind: z.enum(['paid_out', 'drop', 'top_up']), amountCents: z.number().int().positive(), reason: z.string().min(1).max(300), approval });
const closeBody = z.object({ counted: z.object({ cash: cents, card: cents, mobile_money: cents }), varianceReason: z.string().max(300).optional() });
const reasonBody = z.object({ code: z.string().min(1).max(60), label: z.string().min(1).max(120) });
const policyBody = z.object({ role: z.enum(['cashier', 'manager', 'admin']), freeLimitBp: z.number().int().min(0).max(10000), approveCeilingBp: z.number().int().min(0).max(10000), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export function posRouter(pool: Pool): Router {
  const r = Router();
  r.use(requireAuth(pool));
  const ctx = { pool };

  // ---------------------------------------------------------------- till
  r.get('/till/current', requirePermission('till.operate'), handler(async (req, res) => {
    const s = await getOpenSession(pool, req.user!.username);
    res.json({ session: s, expected: s ? await expectedByMethod(pool, s.id) : null });
  }));
  r.post('/till/sessions', requirePermission('till.operate'), handler(async (req, res) => {
    res.status(201).json({ session: await openSession(ctx, { cashier: req.user!.username, ...parse(openBody, req.body) }) });
  }));
  r.get('/till/sessions', requirePermission('till.signoff'), handler(async (req, res) => {
    const q = req.query;
    res.json(await listSessions(pool, { status: typeof q.status === 'string' ? q.status : undefined, cashier: typeof q.cashier === 'string' ? q.cashier : undefined, needsSignoff: q.needsSignoff === 'true', ...paging(q) }));
  }));
  r.get('/till/sessions/:id', requirePermission('till.operate'), handler(async (req, res) => {
    const s = await getSession(pool, idParam(req.params.id));
    if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Till session not found.');
    if (s.cashier !== req.user!.username && req.user!.role === 'cashier') throw new HttpError(403, 'FORBIDDEN', 'That is another person\'s till session.');
    const counts = await pool.query(`SELECT method, expected_cents, counted_cents, variance_cents FROM cash_session_counts WHERE session_id = $1 ORDER BY method`, [s.id]);
    res.json({ session: s, expected: await expectedByMethod(pool, s.id), counts: counts.rows.map((c) => ({ method: c.method, expectedCents: c.expected_cents, countedCents: c.counted_cents, varianceCents: c.variance_cents })) });
  }));
  // Cash in or out of the drawer: a second person (a manager) approves by entering their own username and password.
  r.post('/till/sessions/:id/movements', requirePermission('till.operate'), handler(async (req, res) => {
    const b = parse(movementBody, req.body);
    const ap = await approverFrom(pool, b.approval, req.user!, 'this cash movement');
    res.status(201).json(await recordCashMovement(ctx, { sessionId: idParam(req.params.id), kind: b.kind, amountCents: b.amountCents, reason: b.reason, requestedBy: req.user!.username, approvedBy: ap.approver, approverRole: ap.approverRole }));
  }));
  r.post('/till/sessions/:id/close', requirePermission('till.operate'), handler(async (req, res) => {
    res.json(await closeSession(ctx, { sessionId: idParam(req.params.id), actor: req.user!.username, ...parse(closeBody, req.body) }));
  }));
  r.post('/till/sessions/:id/signoff', requirePermission('till.signoff'), handler(async (req, res) => {
    res.json({ session: await signOffSession(ctx, { sessionId: idParam(req.params.id), approver: req.user!.username, approverRole: req.user!.role }) });
  }));

  // ---------------------------------------------------------------- sales
  r.get('/sales', requirePermission('till.operate'), handler(async (req, res) => {
    const q = req.query;
    // A cashier sees only their own sales; managers see everyone's.
    const cashier = req.user!.role === 'cashier' ? req.user!.username : typeof q.cashier === 'string' ? q.cashier : undefined;
    res.json(await listSales(pool, { cashier, sessionId: q.sessionId === undefined ? undefined : idParam(q.sessionId), status: typeof q.status === 'string' ? q.status : undefined, ...paging(q) }));
  }));
  r.get('/sales/:id', requirePermission('till.operate'), handler(async (req, res) => {
    const s = await getSale(pool, idParam(req.params.id));
    if (!s) throw new HttpError(404, 'SALE_NOT_FOUND', 'Sale not found.');
    if (s.cashier !== req.user!.username && req.user!.role === 'cashier') throw new HttpError(403, 'FORBIDDEN', 'That is another person\'s sale.');
    res.json({ sale: s });
  }));
  r.post('/sales', requirePermission('pos.sell'), handler(async (req, res) => {
    const b = parse(checkoutBody, req.body);
    // The cashier and their role come from the login. An approver is only looked at if one was supplied.
    const ap = b.approval ? await approverFrom(pool, b.approval, req.user!, 'this discount') : undefined;
    const sale = await checkout(ctx, { cashier: req.user!.username, cashierRole: req.user!.role, items: b.items, saleDiscountCents: b.saleDiscountCents, discountReason: b.discountReason, payments: b.payments, clientSaleId: b.clientSaleId, approval: ap });
    res.status(sale.replayed ? 200 : 201).json({ sale });
  }));
  r.post('/sales/:id/void', requirePermission('pos.sell'), handler(async (req, res) => {
    const b = parse(voidBody, req.body);
    const ap = await approverFrom(pool, b.approval, req.user!, 'this void');
    res.json({ sale: await voidSale(ctx, { saleId: idParam(req.params.id), reason: b.reason, actor: req.user!.username, ...ap }) });
  }));
  r.post('/sales/:id/refund', requirePermission('pos.sell'), handler(async (req, res) => {
    const b = parse(refundBody, req.body);
    const ap = await approverFrom(pool, b.approval, req.user!, 'this refund');
    res.status(201).json(await refundSale(ctx, { saleId: idParam(req.params.id), items: b.items, method: b.method, reason: b.reason, restock: b.restock, actor: req.user!.username, ...ap }));
  }));

  // ---------------------------------------------------------------- discount reasons and limits
  r.get('/discount-reasons', requirePermission('pos.sell'), handler(async (req, res) => { res.json({ reasons: await listDiscountReasons(pool, { activeOnly: req.query.all !== 'true' }) }); }));
  r.post('/discount-reasons', requirePermission('policy.manage'), handler(async (req, res) => {
    res.status(201).json({ reason: await addDiscountReason(pool, { ...parse(reasonBody, req.body), actor: req.user!.username }) });
  }));
  r.put('/discount-reasons/:code/active', requirePermission('policy.manage'), handler(async (req, res) => {
    const { active } = parse(z.object({ active: z.boolean() }), req.body);
    await setDiscountReasonActive(pool, { code: String(req.params.code), active, actor: req.user!.username });
    res.json({ ok: true });
  }));
  r.get('/discount-policies', requirePermission('reports.view'), handler(async (_req, res) => { res.json({ policies: await listPolicies(pool) }); }));
  r.put('/discount-policies', requirePermission('policy.manage'), handler(async (req, res) => {
    res.status(201).json({ policy: await setDiscountPolicy(pool, { ...parse(policyBody, req.body), actor: req.user!.username }) });
  }));

  // ---------------------------------------------------------------- audit trail
  r.get('/audit', requirePermission('audit.view'), handler(async (req, res) => {
    const q = req.query;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const dt = (v: unknown) => { const s = str(v); if (!s) return undefined; const d = new Date(s); if (Number.isNaN(d.getTime())) throw new HttpError(422, 'VALIDATION', 'Dates must be ISO dates.'); return d; };
    res.json(await listAudit(pool, { actor: str(q.actor), action: str(q.action), entityType: str(q.entityType), minRisk: q.minRisk === undefined ? undefined : Number(q.minRisk), from: dt(q.from), to: dt(q.to), ...paging(q) }));
  }));

  return r;
}
