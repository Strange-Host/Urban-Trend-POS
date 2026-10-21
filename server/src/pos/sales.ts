import type pg from 'pg';
import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { cr, dr, postEntryTx, reverseEntryTx, type LineInput } from '../ledger/ledger.js';
import { receiptPeriod } from '../ledger/receipts.js';
import { audit } from './audit.js';
import { discountBp, exceedsBp, policyFor, requireApprover } from './policy.js';
import { expectedByMethod, getOpenSession, METHODS, METHOD_ACCOUNT, type Method } from './sessions.js';

// POS sales on the ledger.
//   checkout  Dr the payment method(s), Dr sales discounts, Cr sales (gross). A session must be open.
//   void      reverses that entry exactly; only while the session is open (after close-out, refund instead); needs a manager.
//   refund    Dr sales (gross of the refunded lines), Cr sales discounts (their share), Cr the method paid back; needs a manager.
// Every one writes an audit row in the same transaction.

export interface PosCtx { pool: Pool }

export interface SaleItemInput { sku?: string; name: string; quantity: number; unitPriceCents: number; discountCents?: number }
export interface PaymentInput { method: Method; amountCents: number; reference?: string }

export interface CheckoutInput {
  cashier: string;
  /** The cashier's role, which decides their discount limit. */
  cashierRole: string;
  items: SaleItemInput[];
  /** A discount on the whole sale, on top of any line discounts. */
  saleDiscountCents?: number;
  /** Required whenever there is any discount. */
  discountReason?: string;
  payments: PaymentInput[];
  /** Makes a retried (or offline-queued) sale safe to send twice. */
  clientSaleId?: string;
  /** Needed when the discount is above the cashier's own limit: a manager or admin, never the cashier. */
  approval?: { approver: string; approverRole: string };
}

export interface SaleView {
  id: number;
  saleNo: string;
  sessionId: number;
  cashier: string;
  status: 'completed' | 'voided';
  grossCents: number;
  lineDiscountCents: number;
  saleDiscountCents: number;
  totalCents: number;
  discountReason: string | null;
  items: { id: number; sku: string | null; name: string; quantity: number; unitPriceCents: number; discountCents: number; lineTotalCents: number; refundedQuantity: number }[];
  payments: { method: Method; amountCents: number; reference: string | null }[];
  refundedCents: number;
  createdAt: Date;
  replayed?: boolean;
}

interface SaleRow {
  id: number; sale_no: string; session_id: number; cashier: string; status: 'completed' | 'voided'; gross_cents: number; line_discount_cents: number;
  sale_discount_cents: number; total_cents: number; discount_reason: string | null; created_at: Date; entry_id: number;
}

export async function getSale(db: Queryable, saleId: number): Promise<SaleView | null> {
  const s = await db.query<SaleRow>(`SELECT * FROM sales WHERE id = $1`, [saleId]);
  const r = s.rows[0];
  if (!r) return null;
  const [items, pays, refunded] = await Promise.all([
    db.query(`SELECT i.id, i.sku, i.name, i.quantity, i.unit_price_cents, i.discount_cents, i.line_total_cents,
                     COALESCE((SELECT sum(ri.quantity) FROM sale_refund_items ri WHERE ri.sale_item_id = i.id), 0)::int AS refunded
                FROM sale_items i WHERE i.sale_id = $1 ORDER BY i.id`, [saleId]),
    db.query(`SELECT method, amount_cents, reference FROM sale_payments WHERE sale_id = $1 ORDER BY id`, [saleId]),
    db.query<{ s: number }>(`SELECT COALESCE(sum(amount_cents), 0)::bigint AS s FROM sale_refunds WHERE sale_id = $1`, [saleId]),
  ]);
  return {
    id: r.id, saleNo: r.sale_no, sessionId: r.session_id, cashier: r.cashier, status: r.status, grossCents: r.gross_cents, lineDiscountCents: r.line_discount_cents,
    saleDiscountCents: r.sale_discount_cents, totalCents: r.total_cents, discountReason: r.discount_reason, createdAt: r.created_at,
    items: items.rows.map((i) => ({ id: i.id, sku: i.sku, name: i.name, quantity: i.quantity, unitPriceCents: i.unit_price_cents, discountCents: i.discount_cents, lineTotalCents: i.line_total_cents, refundedQuantity: i.refunded })),
    payments: pays.rows.map((p) => ({ method: p.method, amountCents: p.amount_cents, reference: p.reference })),
    refundedCents: refunded.rows[0]!.s,
  };
}

const needActor = (v: string | undefined, label: string) => { if (!v?.trim()) throw new HttpError(422, 'POS_NO_ACTOR', `${label} is required.`); return v.trim(); };

async function nextSaleNo(c: pg.PoolClient): Promise<string> {
  const period = receiptPeriod(new Date());
  const r = await c.query<{ last_no: number }>(
    `INSERT INTO sale_counters (period, last_no) VALUES ($1, 1) ON CONFLICT (period) DO UPDATE SET last_no = sale_counters.last_no + 1 RETURNING last_no`, [period]);
  if (r.rows[0]!.last_no > 999_999) throw new HttpError(500, 'SALE_COUNTER_FULL', 'Sale numbers for this month are exhausted.');
  return `S-${period}-${String(r.rows[0]!.last_no).padStart(6, '0')}`;
}

/**
 * Rings up a sale. Discount rules, in order: a discount can never exceed its line or the sale; any discount needs an active reason
 * code; a discount above the cashier's own limit needs a manager or admin (not the cashier) whose own ceiling covers it. The
 * payments must add up to the total. Everything, including the audit rows, is one transaction.
 */
export async function checkout(ctx: PosCtx, input: CheckoutInput): Promise<SaleView> {
  const cashier = needActor(input.cashier, 'The cashier');
  if (!Array.isArray(input.items) || input.items.length === 0) throw new HttpError(422, 'SALE_NO_ITEMS', 'A sale needs at least one item.');

  let gross = 0, lineDiscount = 0;
  const lines = input.items.map((i) => {
    const disc = i.discountCents ?? 0;
    for (const [label, v] of [['quantity', i.quantity], ['unit price', i.unitPriceCents], ['discount', disc]] as const) {
      if (!Number.isSafeInteger(v) || v < 0) throw new HttpError(422, 'SALE_BAD_AMOUNT', `"${i.name}": ${label} must be a whole non-negative number.`);
    }
    if (i.quantity < 1) throw new HttpError(422, 'SALE_BAD_AMOUNT', `"${i.name}": quantity must be at least 1.`);
    const lineGross = i.unitPriceCents * i.quantity;
    if (disc > lineGross) throw new HttpError(422, 'DISCOUNT_EXCEEDS_LINE', `Discount on "${i.name}" cannot be more than the line value.`);
    gross += lineGross; lineDiscount += disc;
    return { ...i, discount: disc, lineTotal: lineGross - disc };
  });
  const saleDiscount = input.saleDiscountCents ?? 0;
  if (!Number.isSafeInteger(saleDiscount) || saleDiscount < 0) throw new HttpError(422, 'SALE_BAD_AMOUNT', 'The sale discount must be a whole non-negative number.');
  if (gross <= 0) throw new HttpError(422, 'SALE_TOTAL_NOT_POSITIVE', 'A sale must have something to pay.');
  if (lineDiscount + saleDiscount >= gross) throw new HttpError(422, 'DISCOUNT_EXCEEDS_SALE', 'The discounts cannot add up to the whole value of the sale or more.');
  const totalDiscount = lineDiscount + saleDiscount;
  const total = gross - totalDiscount;

  const payments = input.payments ?? [];
  if (payments.length === 0) throw new HttpError(422, 'PAYMENT_REQUIRED', 'A sale needs a payment.');
  if (new Set(payments.map((p) => p.method)).size !== payments.length) throw new HttpError(422, 'PAYMENT_DUPLICATE_METHOD', 'List each payment method once.');
  for (const p of payments) {
    if (!METHODS.includes(p.method)) throw new HttpError(422, 'PAYMENT_BAD_METHOD', 'Pay by cash, card or mobile_money.');
    if (!Number.isSafeInteger(p.amountCents) || p.amountCents <= 0) throw new HttpError(422, 'PAYMENT_BAD_AMOUNT', 'A payment must be a positive whole number of cents.');
    if (p.method !== 'cash' && !p.reference?.trim()) throw new HttpError(422, 'PAYMENT_REFERENCE_REQUIRED', `A ${p.method.replace('_', ' ')} payment needs its reference (the M-Pesa code or card approval code).`);
  }
  const paid = payments.reduce((s, p) => s + p.amountCents, 0);
  if (paid !== total) throw new HttpError(422, 'PAYMENT_MISMATCH', `The sale is ${total} cents but the payments add up to ${paid}.`);

  return withTransaction(ctx.pool, async (c) => {
    const session = await getOpenSession(c, cashier);
    if (!session) throw new HttpError(409, 'NO_OPEN_SESSION', 'Open a till session before selling.');
    await c.query(`SELECT id FROM cash_sessions WHERE id = $1 FOR UPDATE`, [session.id]); // sales, refunds and movements for a session are serialized

    // ---- discount controls
    let reason: string | null = null;
    let approval: { approver: string; approverRole: string; bp: number } | null = null;
    if (totalDiscount > 0) {
      if (!input.discountReason?.trim()) throw new HttpError(422, 'DISCOUNT_REASON_REQUIRED', 'Any discount needs a reason code.');
      const rc = await c.query<{ active: boolean }>(`SELECT active FROM discount_reasons WHERE code = $1`, [input.discountReason.trim()]);
      if (!rc.rows[0] || !rc.rows[0].active) throw new HttpError(422, 'DISCOUNT_REASON_UNKNOWN', `"${input.discountReason}" is not an active discount reason.`);
      reason = input.discountReason.trim();
      const policy = await policyFor(c, input.cashierRole);
      const bp = discountBp(totalDiscount, gross);
      if (exceedsBp(totalDiscount, gross, policy.freeLimitBp)) {
        const a = input.approval;
        if (!a?.approver?.trim()) {
          throw new HttpError(403, 'DISCOUNT_NEEDS_APPROVAL', `A ${input.cashierRole} can discount up to ${policy.freeLimitBp / 100}% without approval. This is ${bp / 100}%: a manager must approve it.`,
            { limitBp: policy.freeLimitBp, discountBp: bp });
        }
        if (a.approver.trim() === cashier) throw new HttpError(403, 'DISCOUNT_SELF_APPROVAL', 'A discount above your limit must be approved by someone else.');
        const ap = await requireApprover(c, a.approverRole);
        if (exceedsBp(totalDiscount, gross, ap.approveCeilingBp)) {
          throw new HttpError(403, 'DISCOUNT_ABOVE_APPROVER_LIMIT', `A ${a.approverRole} can approve up to ${ap.approveCeilingBp / 100}%. This is ${bp / 100}%.`, { ceilingBp: ap.approveCeilingBp, discountBp: bp });
        }
        approval = { approver: a.approver.trim(), approverRole: a.approverRole, bp };
      }
    }

    // ---- the ledger entry: payments in, discount given, sales (gross) out
    const lineEntries: LineInput[] = payments.map((p) => dr(METHOD_ACCOUNT[p.method], p.amountCents));
    if (totalDiscount > 0) lineEntries.push(dr('SALES_DISCOUNTS', totalDiscount));
    lineEntries.push(cr('SALES', gross));
    const clientId = input.clientSaleId?.trim() || undefined;
    if (clientId) await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`sale:${clientId}`]);
    const { entry, replayed } = await postEntryTx(c, {
      description: `POS sale by ${cashier}`, actor: cashier, lines: lineEntries, idempotencyKey: clientId ? `sale:${clientId}` : undefined,
    });
    if (replayed) {
      const prior = await c.query<{ id: number }>(`SELECT id FROM sales WHERE entry_id = $1`, [entry.id]);
      return { ...(await getSale(c, prior.rows[0]!.id))!, replayed: true };
    }

    const saleNo = await nextSaleNo(c);
    const ins = await c.query<{ id: number }>(
      `INSERT INTO sales (sale_no, session_id, cashier, cashier_role, gross_cents, line_discount_cents, sale_discount_cents, total_cents, discount_reason, client_sale_id, entry_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [saleNo, session.id, cashier, input.cashierRole, gross, lineDiscount, saleDiscount, total, reason, clientId ?? null, entry.id]);
    const saleId = ins.rows[0]!.id;
    for (const l of lines) {
      await c.query(`INSERT INTO sale_items (sale_id, sku, name, quantity, unit_price_cents, discount_cents, line_total_cents) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [saleId, l.sku ?? null, l.name.trim(), l.quantity, l.unitPriceCents, l.discount, l.lineTotal]);
    }
    for (const p of payments) {
      await c.query(`INSERT INTO sale_payments (sale_id, method, amount_cents, reference) VALUES ($1, $2, $3, $4)`, [saleId, p.method, p.amountCents, p.reference?.trim() || null]);
    }
    if (approval) {
      await c.query(`INSERT INTO discount_approvals (sale_id, approver, approver_role, discount_bp, reason_code) VALUES ($1, $2, $3, $4, $5)`,
        [saleId, approval.approver, approval.approverRole, approval.bp, reason]);
    }
    await audit(c, { actor: cashier, role: input.cashierRole, action: 'checkout', entityType: 'sale', entityId: saleId, amountCents: total,
      details: { sale_no: saleNo, session_id: session.id, methods: payments.map((p) => p.method) } });
    if (totalDiscount > 0) {
      await audit(c, { actor: cashier, role: input.cashierRole, action: 'discount_given', entityType: 'sale', entityId: saleId, amountCents: totalDiscount, risk: approval ? 2 : 1,
        details: { sale_no: saleNo, discount_bp: discountBp(totalDiscount, gross), reason, approved_by: approval?.approver ?? null } });
    }
    return (await getSale(c, saleId))!;
  });
}

/**
 * Voids a sale: the ledger entry is reversed exactly. Only while the till session is still open (after close-out the cash has
 * been counted, so refund instead), only if nothing has been refunded, and only with a manager's approval and a reason.
 */
export async function voidSale(ctx: PosCtx, input: { saleId: number; reason: string; actor: string; approver: string; approverRole: string }): Promise<SaleView> {
  const actor = needActor(input.actor, 'The person voiding the sale');
  if (!input.reason?.trim()) throw new HttpError(422, 'VOID_REASON_REQUIRED', 'A reason is required to void a sale.');
  if (!input.approver?.trim()) throw new HttpError(422, 'VOID_NEEDS_APPROVER', 'A manager must approve a void.');
  if (input.approver.trim() === actor) throw new HttpError(403, 'VOID_SELF_APPROVAL', 'A void must be approved by someone other than the person asking for it.');
  return withTransaction(ctx.pool, async (c) => {
    await requireApprover(c, input.approverRole);
    const found = await c.query<SaleRow>(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [input.saleId]);
    const sale = found.rows[0];
    if (!sale) throw new HttpError(404, 'SALE_NOT_FOUND', 'Sale not found.');
    if (sale.status !== 'completed') throw new HttpError(409, 'SALE_ALREADY_VOIDED', 'This sale has already been voided.');
    const sess = await c.query<{ status: string }>(`SELECT status FROM cash_sessions WHERE id = $1 FOR UPDATE`, [sale.session_id]);
    if (sess.rows[0]!.status !== 'open') throw new HttpError(409, 'SESSION_CLOSED_USE_REFUND', 'That till session has been closed and counted. Refund the sale instead of voiding it.');
    const refunds = await c.query(`SELECT 1 FROM sale_refunds WHERE sale_id = $1 LIMIT 1`, [sale.id]);
    if (refunds.rows[0]) throw new HttpError(409, 'SALE_HAS_REFUNDS', 'A sale that has been partly refunded cannot be voided.');

    const reversal = await reverseEntryTx(c, { entryId: sale.entry_id, reason: `Sale ${sale.sale_no} voided: ${input.reason.trim()}`, actor });
    await c.query(`UPDATE sales SET status = 'voided', voided_by = $2, voided_at = now(), void_reason = $3, void_entry_id = $4 WHERE id = $1`, [sale.id, actor, input.reason.trim(), reversal.id]);
    await audit(c, { actor, action: 'void', entityType: 'sale', entityId: sale.id, amountCents: sale.total_cents, risk: 2,
      details: { sale_no: sale.sale_no, reason: input.reason.trim(), approved_by: input.approver.trim(), original_cashier: sale.cashier } });
    return (await getSale(c, sale.id))!;
  });
}

export interface RefundResult { refundId: number; grossCents: number; discountCents: number; amountCents: number; method: Method; sale: SaleView }

/**
 * Refunds some or all of a sale's lines, paying back by a method the customer paid with. Posts: sales down by the lines' gross,
 * sales discounts back by their share, the method's account down by what is paid back. Needs a manager and a reason, an open
 * session of the person doing it (the money leaves THEIR drawer), and cannot refund more than was sold or paid.
 */
export async function refundSale(ctx: PosCtx, input: {
  saleId: number; items: { saleItemId: number; quantity: number }[]; method: Method; reason: string; actor: string; approver: string; approverRole: string;
}): Promise<RefundResult> {
  const actor = needActor(input.actor, 'The person doing the refund');
  if (!input.reason?.trim()) throw new HttpError(422, 'REFUND_REASON_REQUIRED', 'A reason is required for a refund.');
  if (!input.approver?.trim()) throw new HttpError(422, 'REFUND_NEEDS_APPROVER', 'A manager must approve a refund.');
  if (input.approver.trim() === actor) throw new HttpError(403, 'REFUND_SELF_APPROVAL', 'A refund must be approved by someone other than the person doing it.');
  if (!METHODS.includes(input.method)) throw new HttpError(422, 'PAYMENT_BAD_METHOD', 'Refund by cash, card or mobile_money.');
  if (!Array.isArray(input.items) || input.items.length === 0) throw new HttpError(422, 'REFUND_NO_ITEMS', 'Say which items are being refunded.');
  if (new Set(input.items.map((i) => i.saleItemId)).size !== input.items.length) throw new HttpError(422, 'REFUND_DUPLICATE_ITEM', 'List each item once.');
  for (const i of input.items) if (!Number.isSafeInteger(i.quantity) || i.quantity < 1) throw new HttpError(422, 'REFUND_BAD_QUANTITY', 'Each quantity must be a whole number, at least 1.');

  return withTransaction(ctx.pool, async (c) => {
    await requireApprover(c, input.approverRole);
    const session = await getOpenSession(c, actor);
    if (!session) throw new HttpError(409, 'NO_OPEN_SESSION', 'Open a till session first: the refund comes out of your drawer.');
    await c.query(`SELECT id FROM cash_sessions WHERE id = $1 FOR UPDATE`, [session.id]);
    const found = await c.query<SaleRow>(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [input.saleId]);
    const sale = found.rows[0];
    if (!sale) throw new HttpError(404, 'SALE_NOT_FOUND', 'Sale not found.');
    if (sale.status !== 'completed') throw new HttpError(409, 'SALE_NOT_REFUNDABLE', 'A voided sale cannot be refunded.');

    const paidBy = await c.query<{ amount_cents: number }>(`SELECT amount_cents FROM sale_payments WHERE sale_id = $1 AND method = $2`, [sale.id, input.method]);
    if (!paidBy.rows[0]) throw new HttpError(422, 'REFUND_METHOD_NOT_USED', `The customer did not pay this sale by ${input.method.replace('_', ' ')}.`);

    const all = await c.query<{ id: number; quantity: number; unit_price_cents: number; discount_cents: number; line_total_cents: number; refunded: number }>(
      `SELECT i.id, i.quantity, i.unit_price_cents, i.discount_cents, i.line_total_cents,
              COALESCE((SELECT sum(ri.quantity) FROM sale_refund_items ri WHERE ri.sale_item_id = i.id), 0)::int AS refunded
         FROM sale_items i WHERE i.sale_id = $1 ORDER BY i.id`, [sale.id]);
    const byId = new Map(all.rows.map((r) => [r.id, r]));

    // Amounts use cumulative rounding-down shares, so refunding every unit of a line returns EXACTLY its total, never a cent more or less.
    const share = (value: number, after: number, before: number, qty: number) => Math.floor((value * after) / qty) - Math.floor((value * before) / qty);
    let gross = 0, lineDiscountBack = 0;
    let netBefore = 0, netAfter = 0;
    for (const r of all.rows) {
      const want = input.items.find((i) => i.saleItemId === r.id)?.quantity ?? 0;
      netBefore += Math.floor((r.line_total_cents * r.refunded) / r.quantity);
      netAfter += Math.floor((r.line_total_cents * (r.refunded + want)) / r.quantity);
      if (want > 0) {
        if (r.refunded + want > r.quantity) throw new HttpError(422, 'REFUND_EXCEEDS_SOLD', `Only ${r.quantity - r.refunded} of item ${r.id} can still be refunded.`);
        gross += r.unit_price_cents * want;
        lineDiscountBack += share(r.discount_cents, r.refunded + want, r.refunded, r.quantity);
      }
    }
    for (const i of input.items) if (!byId.has(i.saleItemId)) throw new HttpError(404, 'SALE_ITEM_NOT_FOUND', `Item ${i.saleItemId} is not on this sale.`);
    const subtotal = all.rows.reduce((s, r) => s + r.line_total_cents, 0);
    const saleDiscountBack = subtotal > 0 ? Math.floor((sale.sale_discount_cents * netAfter) / subtotal) - Math.floor((sale.sale_discount_cents * netBefore) / subtotal) : 0;
    const discount = lineDiscountBack + saleDiscountBack;
    const amount = gross - discount;
    if (amount <= 0) throw new HttpError(422, 'REFUND_NOTHING', 'Those items were free after discounts, so there is nothing to pay back.');

    const alreadyByMethod = await c.query<{ s: number }>(`SELECT COALESCE(sum(amount_cents), 0)::bigint AS s FROM sale_refunds WHERE sale_id = $1 AND method = $2`, [sale.id, input.method]);
    if (alreadyByMethod.rows[0]!.s + amount > paidBy.rows[0].amount_cents) {
      throw new HttpError(422, 'REFUND_EXCEEDS_PAID', `That would pay back more than the ${paidBy.rows[0].amount_cents} cents the customer paid by ${input.method.replace('_', ' ')}.`);
    }
    if (input.method === 'cash') {
      const expected = await expectedByMethod(c, session.id);
      if (amount > expected.cash) throw new HttpError(422, 'INSUFFICIENT_CASH', `Your drawer should hold ${expected.cash} cents; that is less than the ${amount} to refund.`);
    }

    const lines: LineInput[] = [dr('SALES', gross)];
    if (discount > 0) lines.push(cr('SALES_DISCOUNTS', discount));
    lines.push(cr(METHOD_ACCOUNT[input.method], amount));
    const { entry } = await postEntryTx(c, { description: `Refund on sale ${sale.sale_no}: ${input.reason.trim()}`, actor, lines });
    const ref = await c.query<{ id: number }>(
      `INSERT INTO sale_refunds (sale_id, session_id, method, gross_cents, discount_cents, amount_cents, reason, requested_by, approved_by, entry_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [sale.id, session.id, input.method, gross, discount, amount, input.reason.trim(), actor, input.approver.trim(), entry.id]);
    for (const i of input.items) {
      await c.query(`INSERT INTO sale_refund_items (refund_id, sale_item_id, quantity) VALUES ($1, $2, $3)`, [ref.rows[0]!.id, i.saleItemId, i.quantity]);
    }
    await audit(c, { actor, action: 'refund', entityType: 'sale', entityId: sale.id, amountCents: amount, risk: 2,
      details: { sale_no: sale.sale_no, method: input.method, reason: input.reason.trim(), approved_by: input.approver.trim(), refund_id: ref.rows[0]!.id } });
    return { refundId: ref.rows[0]!.id, grossCents: gross, discountCents: discount, amountCents: amount, method: input.method, sale: (await getSale(c, sale.id))! };
  });
}
