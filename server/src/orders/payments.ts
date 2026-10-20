import type pg from 'pg';
import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { accountBalance, cr, dr, postEntryTx } from '../ledger/ledger.js';
import { resolveOrderRef } from '../ledger/refs.js';
import { issueReceiptTx } from '../ledger/receipts.js';
import { normalizePhone } from './orders.js';

// How money from the paybill is matched to orders (plan section 3):
//   1. reference found, amount equals what is owed   -> applied: paid in full, receipt issued
//   2. reference found, amount is less               -> part_paid: balance reduced, receipt issued
//   3. reference found, amount is more               -> excess: the owed part is applied, the rest waits in suspense
//   4. no reference, or one that matches nothing     -> suspense: all of it waits for a person to match it
//   5. transaction code already recorded             -> rejected as a duplicate; nothing is posted twice
//   6. cash handed over at the shop                  -> recordShopCash: allowed only with a reason, and receipted
// An order's balance is its customer-receivable balance in the ledger. A payment is never allowed to push an order
// past what it owes: anything above goes to suspense, so Rule 6 holds by construction.

export interface PaymentCtx { pool: Pool }

export type PaymentOutcome = 'applied' | 'part_paid' | 'excess' | 'suspense';

export interface PaymentResult {
  paymentId: number;
  transCode: string;
  outcome: PaymentOutcome;
  orderRef: string | null;
  amountCents: number;
  appliedCents: number;
  suspenseCents: number;
  receiptNo: string | null;
  duplicate: boolean;
}

export interface PaybillNotice {
  transCode: string;
  amountCents: number;
  msisdn?: string;
  payerName?: string;
  /** What the customer typed into the paybill "account" field. */
  accountRef?: string;
  receivedAt?: Date;
}

const TRANS_CODE = /^[A-Z0-9]{6,20}$/;
const SYSTEM_ACTOR = 'mpesa';

interface PaymentRow {
  id: number; trans_code: string; amount_cents: number; outcome: PaymentOutcome; order_ref: string | null;
  applied_cents: number; receipt_no: string | null;
}
const toResult = (r: PaymentRow, duplicate: boolean): PaymentResult => ({
  paymentId: r.id, transCode: r.trans_code, outcome: r.outcome, orderRef: r.order_ref, amountCents: r.amount_cents,
  appliedCents: r.applied_cents, suspenseCents: r.amount_cents - r.applied_cents, receiptNo: r.receipt_no, duplicate,
});

function validAmount(cents: number): void {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new HttpError(422, 'PAYMENT_BAD_AMOUNT', 'A payment amount must be a positive whole number of cents.');
}

/**
 * Records one paybill notice and matches it. Safe to call again with the same notice (M-Pesa re-sends): the second
 * call changes nothing and returns the first result with duplicate: true. Simultaneous copies are serialized.
 */
export async function ingestPaybillPayment(ctx: PaymentCtx, notice: PaybillNotice): Promise<PaymentResult> {
  const code = String(notice.transCode ?? '').trim().toUpperCase();
  if (!TRANS_CODE.test(code)) throw new HttpError(422, 'PAYMENT_BAD_CODE', 'The transaction code is missing or malformed.');
  validAmount(notice.amountCents);

  return withTransaction(ctx.pool, async (c) => {
    // Two copies of one notice arriving together: the second waits here until the first has committed.
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`paybill:${code}`]);
    const prior = await c.query<PaymentRow>(
      `SELECT id, trans_code, amount_cents, outcome, order_ref, applied_cents, receipt_no FROM paybill_payments WHERE trans_code = $1`, [code]);
    if (prior.rows[0]) return toResult(prior.rows[0], true);

    const typed = notice.accountRef?.trim() ? await resolveOrderRef(c, notice.accountRef) : null;
    const order = typed
      ? (await c.query<{ id: number; order_ref: string }>(`SELECT id, order_ref FROM orders WHERE order_ref = $1 FOR UPDATE`, [typed.ref])).rows[0]
      : undefined;

    const balance = order ? Math.max(await accountBalance(c, 'CUSTOMER_RECEIVABLE', { orderRef: order.order_ref }), 0) : 0;
    const applied = Math.min(notice.amountCents, balance);
    const suspense = notice.amountCents - applied;
    const outcome: PaymentOutcome = !order ? 'suspense'
      : suspense > 0 ? 'excess'
      : applied === balance ? 'applied' : 'part_paid';

    const lines = [dr('PAYBILL_CLEARING', notice.amountCents)];
    if (applied > 0) lines.push(cr('CUSTOMER_RECEIVABLE', applied));
    if (suspense > 0) lines.push(cr('SUSPENSE', suspense));
    const { entry } = await postEntryTx(c, {
      description: `Paybill ${code}${order ? ` for ${order.order_ref}` : ' (unmatched)'}`,
      actor: SYSTEM_ACTOR, orderRef: order?.order_ref ?? null, idempotencyKey: `paybill:${code}`, lines,
    });

    const receipt = applied > 0 && order
      ? await issueReceiptTx(c, { orderRef: order.order_ref, journalEntryId: entry.id, amountCents: applied, method: 'mpesa_paybill', externalRef: code, actor: SYSTEM_ACTOR, at: notice.receivedAt })
      : null;

    const ins = await c.query<PaymentRow>(
      `INSERT INTO paybill_payments (trans_code, amount_cents, msisdn, payer_name, account_raw, received_at, outcome, order_ref, applied_cents, entry_id, receipt_no)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, trans_code, amount_cents, outcome, order_ref, applied_cents, receipt_no`,
      [code, notice.amountCents, notice.msisdn ?? null, notice.payerName ?? null, notice.accountRef ?? null, notice.receivedAt ?? new Date(),
       outcome, order?.order_ref ?? null, applied, entry.id, receipt?.receiptNo ?? null]);
    const payment = ins.rows[0]!;

    if (suspense > 0) {
      await c.query(`INSERT INTO payment_exceptions (payment_id, kind, amount_cents) VALUES ($1, $2, $3)`,
        [payment.id, order ? 'excess' : 'unmatched', suspense]);
    }
    if (order) {
      await c.query(`INSERT INTO order_events (order_id, order_ref, type, data, actor) VALUES ($1, $2, 'payment_received', $3, $4)`,
        [order.id, order.order_ref, JSON.stringify({ trans_code: code, amount_cents: notice.amountCents, applied_cents: applied, suspense_cents: suspense, outcome, receipt_no: receipt?.receiptNo ?? null }), SYSTEM_ACTOR]);
    }
    return toResult(payment, false);
  });
}

export interface SuspenseItem {
  exceptionId: number;
  paymentId: number;
  transCode: string;
  kind: 'unmatched' | 'excess';
  amountCents: number;
  remainingCents: number;
  msisdn: string | null;
  payerName: string | null;
  accountRaw: string | null;
  intendedOrderRef: string | null;
  createdAt: Date;
}

/** Money still waiting in suspense (anything with something remaining), oldest first. */
export async function listSuspense(db: Queryable): Promise<SuspenseItem[]> {
  const { rows } = await db.query(
    `SELECT x.id AS exception_id, p.id AS payment_id, p.trans_code, x.kind, x.amount_cents,
            x.amount_cents - COALESCE((SELECT sum(r.amount_cents) FROM exception_resolutions r WHERE r.exception_id = x.id), 0)::bigint AS remaining,
            p.msisdn, p.payer_name, p.account_raw, p.order_ref, x.created_at
       FROM payment_exceptions x JOIN paybill_payments p ON p.id = x.payment_id
      WHERE x.amount_cents > COALESCE((SELECT sum(r.amount_cents) FROM exception_resolutions r WHERE r.exception_id = x.id), 0)
      ORDER BY x.created_at, x.id`);
  return rows.map((r) => ({
    exceptionId: r.exception_id, paymentId: r.payment_id, transCode: r.trans_code, kind: r.kind, amountCents: r.amount_cents,
    remainingCents: r.remaining, msisdn: r.msisdn, payerName: r.payer_name, accountRaw: r.account_raw, intendedOrderRef: r.order_ref, createdAt: r.created_at,
  }));
}

export interface MatchSuggestion {
  orderRef: string;
  customerName: string;
  balanceCents: number;
  reasons: ('same_phone' | 'exact_amount')[];
}

/** Orders a person might match a suspense item to: same phone number, or owing exactly this amount. Never auto-applied. */
export async function suggestMatches(db: Queryable, exceptionId: number): Promise<MatchSuggestion[]> {
  const ex = await db.query<{ msisdn: string | null; remaining: number }>(
    `SELECT p.msisdn, x.amount_cents - COALESCE((SELECT sum(r.amount_cents) FROM exception_resolutions r WHERE r.exception_id = x.id), 0)::bigint AS remaining
       FROM payment_exceptions x JOIN paybill_payments p ON p.id = x.payment_id WHERE x.id = $1`, [exceptionId]);
  if (!ex.rows[0]) throw new HttpError(404, 'EXCEPTION_NOT_FOUND', 'Suspense item not found.');
  const phone = ex.rows[0].msisdn ? normalizePhone(ex.rows[0].msisdn) : null;
  const { rows } = await db.query<{ order_ref: string; customer_name: string; phone_normalized: string; balance: number }>(
    `SELECT o.order_ref, o.customer_name, o.phone_normalized,
            COALESCE((SELECT sum(l.amount_cents) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                        JOIN accounts a ON a.id = l.account_id WHERE a.code = 'CUSTOMER_RECEIVABLE' AND e.order_ref = o.order_ref), 0)::bigint AS balance
       FROM orders o WHERE o.status IN ('awaiting_dispatch', 'dispatched', 'delivered')`);
  return rows
    .filter((r) => r.balance > 0)
    .map((r) => ({
      orderRef: r.order_ref, customerName: r.customer_name, balanceCents: r.balance,
      reasons: [...(phone && r.phone_normalized === phone ? ['same_phone' as const] : []), ...(r.balance === ex.rows[0]!.remaining ? ['exact_amount' as const] : [])],
    }))
    .filter((s) => s.reasons.length > 0)
    .sort((a, b) => b.reasons.length - a.reasons.length)
    .slice(0, 10);
}

/**
 * A person matches money in suspense to an order. Applies as much as the order still owes; anything left stays in
 * suspense. Issues a receipt for the amount applied.
 */
export async function applySuspenseToOrder(ctx: PaymentCtx, input: { exceptionId: number; orderRef: string; actor: string }) {
  if (!input.actor?.trim()) throw new HttpError(422, 'PAYMENT_NO_ACTOR', 'The person matching this payment is required.');
  return withTransaction(ctx.pool, async (c) => {
    const ex = await lockException(c, input.exceptionId);
    if (ex.remaining <= 0) throw new HttpError(409, 'EXCEPTION_ALREADY_RESOLVED', 'This suspense item has already been fully resolved.');
    const ref = await resolveOrderRef(c, input.orderRef);
    const order = ref ? (await c.query<{ id: number; order_ref: string }>(`SELECT id, order_ref FROM orders WHERE order_ref = $1 FOR UPDATE`, [ref.ref])).rows[0] : undefined;
    if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found.');

    const balance = Math.max(await accountBalance(c, 'CUSTOMER_RECEIVABLE', { orderRef: order.order_ref }), 0);
    const applied = Math.min(ex.remaining, balance);
    if (applied <= 0) throw new HttpError(422, 'ORDER_NOTHING_DUE', 'That order does not owe anything, so there is nothing to apply.');

    const { entry } = await postEntryTx(c, {
      description: `Suspense ${ex.trans_code} applied to ${order.order_ref}`, actor: input.actor, orderRef: order.order_ref,
      lines: [dr('SUSPENSE', applied), cr('CUSTOMER_RECEIVABLE', applied)],
    });
    const receipt = await issueReceiptTx(c, { orderRef: order.order_ref, journalEntryId: entry.id, amountCents: applied, method: 'mpesa_paybill', externalRef: ex.trans_code, actor: input.actor });
    await c.query(
      `INSERT INTO exception_resolutions (exception_id, kind, order_ref, amount_cents, entry_id, receipt_no, actor) VALUES ($1, 'applied', $2, $3, $4, $5, $6)`,
      [ex.id, order.order_ref, applied, entry.id, receipt.receiptNo, input.actor]);
    await c.query(`INSERT INTO order_events (order_id, order_ref, type, data, actor) VALUES ($1, $2, 'suspense_applied', $3, $4)`,
      [order.id, order.order_ref, JSON.stringify({ trans_code: ex.trans_code, applied_cents: applied, receipt_no: receipt.receiptNo }), input.actor]);
    return { appliedCents: applied, remainingCents: ex.remaining - applied, receiptNo: receipt.receiptNo };
  });
}

/** Money in suspense is sent back to the payer. The refund itself happens outside the system; this records it. */
export async function refundSuspense(ctx: PaymentCtx, input: { exceptionId: number; amountCents?: number; reason: string; actor: string }) {
  if (!input.actor?.trim()) throw new HttpError(422, 'PAYMENT_NO_ACTOR', 'The person approving this refund is required.');
  if (!input.reason?.trim()) throw new HttpError(422, 'REFUND_REASON_REQUIRED', 'A reason is required for a refund.');
  return withTransaction(ctx.pool, async (c) => {
    const ex = await lockException(c, input.exceptionId);
    const amount = input.amountCents ?? ex.remaining;
    validAmount(amount);
    if (amount > ex.remaining) throw new HttpError(422, 'REFUND_TOO_LARGE', `Only ${ex.remaining} cents remain in suspense for this payment.`);
    const { entry } = await postEntryTx(c, {
      description: `Suspense ${ex.trans_code} refunded: ${input.reason.trim()}`, actor: input.actor,
      lines: [dr('SUSPENSE', amount), cr('PAYBILL_CLEARING', amount)],
    });
    await c.query(
      `INSERT INTO exception_resolutions (exception_id, kind, amount_cents, entry_id, reason, actor) VALUES ($1, 'refunded', $2, $3, $4, $5)`,
      [ex.id, amount, entry.id, input.reason.trim(), input.actor]);
    return { refundedCents: amount, remainingCents: ex.remaining - amount };
  });
}

/**
 * Cash handed over at the shop. An exception, not a normal path: it needs a reason and cannot exceed what is owed
 * (cash cannot be parked in suspense). Lands in "staff cash in hand" until it is banked.
 */
export async function recordShopCash(ctx: PaymentCtx, input: { orderRef: string; amountCents: number; reason: string; actor: string }) {
  if (!input.actor?.trim()) throw new HttpError(422, 'PAYMENT_NO_ACTOR', 'The person taking the cash is required.');
  if (!input.reason?.trim()) throw new HttpError(422, 'CASH_REASON_REQUIRED', 'Cash at the shop is an exception: a reason is required.');
  validAmount(input.amountCents);
  return withTransaction(ctx.pool, async (c) => {
    const ref = await resolveOrderRef(c, input.orderRef);
    const order = ref ? (await c.query<{ id: number; order_ref: string }>(`SELECT id, order_ref FROM orders WHERE order_ref = $1 FOR UPDATE`, [ref.ref])).rows[0] : undefined;
    if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    const balance = Math.max(await accountBalance(c, 'CUSTOMER_RECEIVABLE', { orderRef: order.order_ref }), 0);
    if (input.amountCents > balance) throw new HttpError(422, 'CASH_EXCEEDS_BALANCE', `That is more than the ${balance} cents this order still owes.`);
    const { entry } = await postEntryTx(c, {
      description: `Shop cash for ${order.order_ref}: ${input.reason.trim()}`, actor: input.actor, orderRef: order.order_ref,
      lines: [dr('STAFF_CASH_IN_HAND', input.amountCents), cr('CUSTOMER_RECEIVABLE', input.amountCents)],
    });
    const receipt = await issueReceiptTx(c, { orderRef: order.order_ref, journalEntryId: entry.id, amountCents: input.amountCents, method: 'cash', actor: input.actor });
    // The cash is now in this person's hands: a custody record stays open until it is deposited (see depositCustody).
    await c.query(`INSERT INTO custody_records (holder, order_ref, amount_cents, receipt_no, entry_id) VALUES ($1, $2, $3, $4, $5)`,
      [input.actor.trim(), order.order_ref, input.amountCents, receipt.receiptNo, entry.id]);
    await c.query(`INSERT INTO order_events (order_id, order_ref, type, data, actor) VALUES ($1, $2, 'shop_cash_recorded', $3, $4)`,
      [order.id, order.order_ref, JSON.stringify({ amount_cents: input.amountCents, reason: input.reason.trim(), receipt_no: receipt.receiptNo }), input.actor]);
    return { receiptNo: receipt.receiptNo, balanceCents: balance - input.amountCents };
  });
}

// Lock the row FIRST, then read what remains in a separate statement. Doing both in one statement can use a stale
// total after waiting for the lock, letting two people apply the same money twice.
async function lockException(c: pg.PoolClient, id: number) {
  const locked = await c.query<{ id: number; trans_code: string }>(
    `SELECT x.id, p.trans_code FROM payment_exceptions x JOIN paybill_payments p ON p.id = x.payment_id WHERE x.id = $1 FOR UPDATE OF x`, [id]);
  if (!locked.rows[0]) throw new HttpError(404, 'EXCEPTION_NOT_FOUND', 'Suspense item not found.');
  const rem = await c.query<{ remaining: number }>(
    `SELECT x.amount_cents - COALESCE((SELECT sum(r.amount_cents) FROM exception_resolutions r WHERE r.exception_id = x.id), 0)::bigint AS remaining
       FROM payment_exceptions x WHERE x.id = $1`, [id]);
  return { id: locked.rows[0].id, trans_code: locked.rows[0].trans_code, remaining: rem.rows[0]!.remaining };
}
