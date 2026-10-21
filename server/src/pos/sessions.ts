import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { cr, dr, postEntryTx, type LineInput } from '../ledger/ledger.js';
import { audit } from './audit.js';
import { requireApprover } from './policy.js';

// The till. A cashier must have an OPEN session to sell. During it, cash can go in and out only as recorded movements
// (each with a reason and a second person's approval). At close-out the cashier counts each payment method; the system
// compares that with what it expected, requires a reason for any difference, posts the difference to the ledger so the books
// match the count, and asks a manager to sign off when the difference is large.

export type Method = 'cash' | 'card' | 'mobile_money';
export const METHODS: Method[] = ['cash', 'card', 'mobile_money'];
/** The ledger account each payment method lands in. */
export const METHOD_ACCOUNT: Record<Method, string> = { cash: 'TILL', card: 'CARD_CLEARING', mobile_money: 'MOBILE_MONEY_TILL' };

/** A difference larger than this (in total, across methods) needs a manager's sign-off. KES 500 by default. */
export const DEFAULT_SIGNOFF_THRESHOLD_CENTS = 50_000;

export interface SessionCtx { pool: Pool; signoffThresholdCents?: number }

export interface CashSession {
  id: number;
  cashier: string;
  openingFloatCents: number;
  openedAt: Date;
  status: 'open' | 'closed' | 'signed_off';
  closedAt: Date | null;
  varianceReason: string | null;
  signoffRequired: boolean;
  signedOffBy: string | null;
}

interface Row {
  id: number; cashier: string; opening_float_cents: number; opened_at: Date; status: CashSession['status']; closed_at: Date | null;
  variance_reason: string | null; signoff_required: boolean; signed_off_by: string | null;
}
const COLS = `id, cashier, opening_float_cents, opened_at, status, closed_at, variance_reason, signoff_required, signed_off_by`;
const toSession = (r: Row): CashSession => ({
  id: r.id, cashier: r.cashier, openingFloatCents: r.opening_float_cents, openedAt: r.opened_at, status: r.status, closedAt: r.closed_at,
  varianceReason: r.variance_reason, signoffRequired: r.signoff_required, signedOffBy: r.signed_off_by,
});

export async function getSession(db: Queryable, id: number): Promise<CashSession | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLS} FROM cash_sessions WHERE id = $1`, [id]);
  return rows[0] ? toSession(rows[0]) : null;
}

export async function getOpenSession(db: Queryable, cashier: string): Promise<CashSession | null> {
  const { rows } = await db.query<Row>(`SELECT ${COLS} FROM cash_sessions WHERE cashier = $1 AND status = 'open'`, [cashier]);
  return rows[0] ? toSession(rows[0]) : null;
}

/** Opens the cashier's till session. The float is what they start the drawer with; one open session per cashier. */
export async function openSession(ctx: SessionCtx, input: { cashier: string; openingFloatCents: number }): Promise<CashSession> {
  if (!input.cashier?.trim()) throw new HttpError(422, 'SESSION_NO_CASHIER', 'Who is opening the till?');
  if (!Number.isSafeInteger(input.openingFloatCents) || input.openingFloatCents < 0) throw new HttpError(422, 'SESSION_BAD_FLOAT', 'The opening float must be a whole, non-negative number of cents.');
  return withTransaction(ctx.pool, async (c) => {
    try {
      const { rows } = await c.query<Row>(`INSERT INTO cash_sessions (cashier, opening_float_cents) VALUES ($1, $2) RETURNING ${COLS}`, [input.cashier.trim(), input.openingFloatCents]);
      await audit(c, { actor: input.cashier, action: 'session_opened', entityType: 'cash_session', entityId: rows[0]!.id, amountCents: input.openingFloatCents });
      return toSession(rows[0]!);
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'cash_sessions_one_open_per_cashier') {
        throw new HttpError(409, 'SESSION_ALREADY_OPEN', 'You already have an open till session. Close it before opening another.');
      }
      throw err;
    }
  });
}

export type Expected = Record<Method, number>;

/**
 * What should be in the till for each payment method right now. Cash: the opening float, plus cash sales, minus cash refunds
 * and paid-outs and drops, plus top-ups. Card and mobile money: sales minus refunds. Voided sales are excluded (void is only
 * possible while the session is open, so that money never stayed).
 */
export async function expectedByMethod(db: Queryable, sessionId: number): Promise<Expected> {
  const s = await db.query<{ float: number }>(`SELECT opening_float_cents AS float FROM cash_sessions WHERE id = $1`, [sessionId]);
  if (!s.rows[0]) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Till session not found.');
  const sales = await db.query<{ method: Method; s: number }>(
    `SELECT p.method, sum(p.amount_cents)::bigint AS s FROM sale_payments p JOIN sales x ON x.id = p.sale_id WHERE x.session_id = $1 AND x.status = 'completed' GROUP BY p.method`, [sessionId]);
  const refunds = await db.query<{ method: Method; s: number }>(`SELECT method, sum(amount_cents)::bigint AS s FROM sale_refunds WHERE session_id = $1 GROUP BY method`, [sessionId]);
  const moves = await db.query<{ kind: string; s: number }>(`SELECT kind, sum(amount_cents)::bigint AS s FROM cash_movements WHERE session_id = $1 GROUP BY kind`, [sessionId]);
  const sum = (rows: { method?: Method; kind?: string; s: number }[], key: string) => rows.find((r) => (r.method ?? r.kind) === key)?.s ?? 0;
  return {
    cash: s.rows[0].float + sum(sales.rows, 'cash') - sum(refunds.rows, 'cash') + sum(moves.rows, 'top_up') - sum(moves.rows, 'paid_out') - sum(moves.rows, 'drop'),
    card: sum(sales.rows, 'card') - sum(refunds.rows, 'card'),
    mobile_money: sum(sales.rows, 'mobile_money') - sum(refunds.rows, 'mobile_money'),
  };
}

export type MovementKind = 'paid_out' | 'drop' | 'top_up';
const MOVEMENT_LINES: Record<MovementKind, (cents: number) => LineInput[]> = {
  paid_out: (c) => [dr('PETTY_EXPENSES', c), cr('TILL', c)],   // cash leaves the drawer to pay for something
  drop: (c) => [dr('SAFE', c), cr('TILL', c)],                 // cash moved from the drawer to the safe
  top_up: (c) => [dr('TILL', c), cr('SAFE', c)],               // float added to the drawer from the safe
};

/** A paid-out, drop or top-up: needs a reason and a SECOND person's approval, and cannot take out more cash than the drawer should hold. */
export async function recordCashMovement(ctx: SessionCtx, input: {
  sessionId: number; kind: MovementKind; amountCents: number; reason: string; requestedBy: string; approvedBy: string; approverRole: string;
}): Promise<{ id: number; expectedCashCents: number }> {
  if (!(input.kind in MOVEMENT_LINES)) throw new HttpError(422, 'MOVEMENT_BAD_KIND', 'A cash movement is a paid_out, drop or top_up.');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new HttpError(422, 'MOVEMENT_BAD_AMOUNT', 'The amount must be a positive whole number of cents.');
  if (!input.reason?.trim()) throw new HttpError(422, 'MOVEMENT_REASON_REQUIRED', 'A reason is required.');
  if (!input.requestedBy?.trim() || !input.approvedBy?.trim()) throw new HttpError(422, 'MOVEMENT_NEEDS_APPROVER', 'Both the person asking and the person approving are required.');
  if (input.requestedBy.trim() === input.approvedBy.trim()) throw new HttpError(403, 'MOVEMENT_SELF_APPROVAL', 'A cash movement must be approved by someone other than the person who asked for it.');

  return withTransaction(ctx.pool, async (c) => {
    await requireApprover(c, input.approverRole);
    const s = await c.query<{ status: string }>(`SELECT status FROM cash_sessions WHERE id = $1 FOR UPDATE`, [input.sessionId]); // serialize movements and sales for this session
    if (!s.rows[0]) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Till session not found.');
    if (s.rows[0].status !== 'open') throw new HttpError(409, 'SESSION_NOT_OPEN', 'That till session is closed.');
    const expected = await expectedByMethod(c, input.sessionId);
    if (input.kind !== 'top_up' && input.amountCents > expected.cash) {
      throw new HttpError(422, 'INSUFFICIENT_CASH', `The drawer should hold ${expected.cash} cents; that is less than the ${input.amountCents} asked for.`);
    }
    const { entry } = await postEntryTx(c, {
      description: `Till ${input.kind.replace('_', ' ')}: ${input.reason.trim()}`, actor: input.requestedBy, lines: MOVEMENT_LINES[input.kind](input.amountCents),
    });
    const ins = await c.query<{ id: number }>(
      `INSERT INTO cash_movements (session_id, kind, amount_cents, reason, requested_by, approved_by, entry_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.sessionId, input.kind, input.amountCents, input.reason.trim(), input.requestedBy.trim(), input.approvedBy.trim(), entry.id]);
    await audit(c, { actor: input.requestedBy, action: `cash_${input.kind}`, entityType: 'cash_movement', entityId: ins.rows[0]!.id, amountCents: input.amountCents,
      risk: input.kind === 'top_up' ? 1 : 2, details: { session_id: input.sessionId, reason: input.reason.trim(), approved_by: input.approvedBy.trim() } });
    return { id: ins.rows[0]!.id, expectedCashCents: expected.cash + (input.kind === 'top_up' ? input.amountCents : -input.amountCents) };
  });
}

export interface CloseResult {
  session: CashSession;
  counts: { method: Method; expectedCents: number; countedCents: number; varianceCents: number }[];
  totalAbsVarianceCents: number;
}

/**
 * Close-out. The cashier counts every payment method. Any difference from what was expected needs a reason. The difference is
 * posted to the ledger (over and short), so the books always match the count. A large total difference needs a manager's sign-off.
 */
export async function closeSession(ctx: SessionCtx, input: {
  sessionId: number; actor: string; counted: Record<Method, number>; varianceReason?: string;
}): Promise<CloseResult> {
  for (const m of METHODS) {
    if (!Number.isSafeInteger(input.counted?.[m]) || input.counted[m] < 0) {
      throw new HttpError(422, 'COUNT_MISSING', `Enter the counted amount for ${m.replace('_', ' ')} (zero if there was none).`);
    }
  }
  const threshold = ctx.signoffThresholdCents ?? DEFAULT_SIGNOFF_THRESHOLD_CENTS;
  return withTransaction(ctx.pool, async (c) => {
    const found = await c.query<Row>(`SELECT ${COLS} FROM cash_sessions WHERE id = $1 FOR UPDATE`, [input.sessionId]);
    const s = found.rows[0];
    if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Till session not found.');
    if (s.status !== 'open') throw new HttpError(409, 'SESSION_NOT_OPEN', 'That till session is already closed.');
    if (s.cashier !== input.actor?.trim()) throw new HttpError(403, 'SESSION_NOT_YOURS', 'You can only close your own till session.');

    const expected = await expectedByMethod(c, s.id);
    const counts = METHODS.map((m) => ({ method: m, expectedCents: expected[m], countedCents: input.counted[m], varianceCents: input.counted[m] - expected[m] }));
    const totalAbs = counts.reduce((sum, x) => sum + Math.abs(x.varianceCents), 0);
    if (totalAbs > 0 && !input.varianceReason?.trim()) {
      throw new HttpError(422, 'VARIANCE_REASON_REQUIRED', 'The count differs from what was expected. Enter a reason for the difference.', { counts });
    }

    // Bring the books to the count: a shortage is an expense, an overage the opposite, against the method's own account.
    const lines: LineInput[] = [];
    for (const x of counts.filter((v) => v.varianceCents !== 0)) {
      const acct = METHOD_ACCOUNT[x.method];
      if (x.varianceCents < 0) lines.push(dr('CASH_OVER_SHORT', -x.varianceCents), cr(acct, -x.varianceCents));
      else lines.push(dr(acct, x.varianceCents), cr('CASH_OVER_SHORT', x.varianceCents));
    }
    const entryId = lines.length ? (await postEntryTx(c, { description: `Till session ${s.id} close-out difference: ${input.varianceReason!.trim()}`, actor: s.cashier, lines, idempotencyKey: `session-close:${s.id}` })).entry.id : null;
    for (const x of counts) {
      await c.query(`INSERT INTO cash_session_counts (session_id, method, expected_cents, counted_cents, variance_cents, entry_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [s.id, x.method, x.expectedCents, x.countedCents, x.varianceCents, x.varianceCents !== 0 ? entryId : null]);
    }
    const needsSignoff = totalAbs > threshold;
    const upd = await c.query<Row>(
      `UPDATE cash_sessions SET status = 'closed', closed_at = now(), variance_reason = $2, signoff_required = $3 WHERE id = $1 RETURNING ${COLS}`,
      [s.id, input.varianceReason?.trim() || null, needsSignoff]);
    await audit(c, { actor: s.cashier, action: 'session_closed', entityType: 'cash_session', entityId: s.id, amountCents: totalAbs, risk: needsSignoff ? 2 : totalAbs > 0 ? 1 : 0,
      details: { counts, variance_reason: input.varianceReason?.trim() ?? null, signoff_required: needsSignoff } });
    return { session: toSession(upd.rows[0]!), counts, totalAbsVarianceCents: totalAbs };
  });
}

/** A manager signs off a close-out whose difference was large. The signer cannot be the cashier. */
export async function signOffSession(ctx: SessionCtx, input: { sessionId: number; approver: string; approverRole: string }): Promise<CashSession> {
  if (!input.approver?.trim()) throw new HttpError(422, 'SIGNOFF_NO_APPROVER', 'The person signing off is required.');
  return withTransaction(ctx.pool, async (c) => {
    await requireApprover(c, input.approverRole);
    const found = await c.query<Row>(`SELECT ${COLS} FROM cash_sessions WHERE id = $1 FOR UPDATE`, [input.sessionId]);
    const s = found.rows[0];
    if (!s) throw new HttpError(404, 'SESSION_NOT_FOUND', 'Till session not found.');
    if (s.status === 'signed_off') throw new HttpError(409, 'SESSION_ALREADY_SIGNED_OFF', 'This session has already been signed off.');
    if (s.status !== 'closed' || !s.signoff_required) throw new HttpError(409, 'SIGNOFF_NOT_NEEDED', 'This session does not need a sign-off.');
    if (s.cashier === input.approver.trim()) throw new HttpError(403, 'SIGNOFF_SELF', 'A manager other than the cashier must sign this off.');
    const upd = await c.query<Row>(`UPDATE cash_sessions SET status = 'signed_off', signed_off_by = $2, signed_off_at = now() WHERE id = $1 RETURNING ${COLS}`, [s.id, input.approver.trim()]);
    await audit(c, { actor: input.approver, role: input.approverRole, action: 'session_signed_off', entityType: 'cash_session', entityId: s.id, risk: 1 });
    return toSession(upd.rows[0]!);
  });
}
