import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { cr, dr, postEntryTx } from '../ledger/ledger.js';
import { resolveOrderRef } from '../ledger/refs.js';

// What we owe couriers, kept strictly apart from customer money (plan section 2).
//   Package fee   what a courier earns for a dispatch. Entered by staff at dispatch (see dispatchOrder). Owed from the
//                 moment of dispatch whether or not the customer claims the parcel.
//   Courier cost  extras: return trip, fuel, airtime, handling, repair. Entered, then approved by someone else.
// Both post to the courier's payable balance (COURIER_PAYABLE, per courier) but to DIFFERENT expense accounts, and a payout
// lists them as separate lines, so reports can show them side by side without mixing them (Rule 12).

export type CostKind = 'return_trip' | 'fuel' | 'airtime' | 'handling' | 'repair' | 'other';

export interface PayablesCtx { pool: Pool }

export interface CourierCost {
  id: number;
  courierId: number;
  orderRef: string | null;
  kind: CostKind;
  amountCents: number;
  description: string;
  receiptRef: string | null;
  status: 'pending' | 'approved' | 'rejected';
  recordedBy: string;
  decidedBy: string | null;
}

interface CostRow {
  id: number; courier_id: number; order_ref: string | null; kind: CostKind; amount_cents: number; description: string;
  receipt_ref: string | null; status: CourierCost['status']; recorded_by: string; decided_by: string | null;
}
const COST_COLS = `id, courier_id, order_ref, kind, amount_cents, description, receipt_ref, status, recorded_by, decided_by`;
const toCost = (r: CostRow): CourierCost => ({
  id: r.id, courierId: r.courier_id, orderRef: r.order_ref, kind: r.kind, amountCents: r.amount_cents, description: r.description,
  receiptRef: r.receipt_ref, status: r.status, recordedBy: r.recorded_by, decidedBy: r.decided_by,
});

/** Enters a cost. It owes nothing until someone else approves it. */
export async function recordCourierCost(ctx: PayablesCtx, input: {
  courierId: number; kind: CostKind; amountCents: number; description: string; orderRef?: string; receiptRef?: string; actor: string;
}): Promise<CourierCost> {
  if (!input.actor?.trim()) throw new HttpError(422, 'COST_NO_ACTOR', 'The person entering the cost is required.');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new HttpError(422, 'COST_BAD_AMOUNT', 'A cost must be a positive whole number of cents.');
  if (!input.description?.trim()) throw new HttpError(422, 'COST_NO_DESCRIPTION', 'Say what the cost was for.');
  return withTransaction(ctx.pool, async (c) => {
    const courier = await c.query<{ active: boolean }>(`SELECT active FROM couriers WHERE id = $1`, [input.courierId]);
    if (!courier.rows[0]) throw new HttpError(404, 'COURIER_NOT_FOUND', 'Courier not found.');
    let ref: string | null = null;
    if (input.orderRef) {
      const r = await resolveOrderRef(c, input.orderRef);
      if (!r) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found.');
      ref = r.ref;
    }
    const { rows } = await c.query<CostRow>(
      `INSERT INTO courier_costs (courier_id, order_ref, kind, amount_cents, description, receipt_ref, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COST_COLS}`,
      [input.courierId, ref, input.kind, input.amountCents, input.description.trim(), input.receiptRef?.trim() || null, input.actor.trim()]);
    return toCost(rows[0]!);
  });
}

async function lockPendingCost(c: import('pg').PoolClient, costId: number, actor: string): Promise<CostRow> {
  const { rows } = await c.query<CostRow>(`SELECT ${COST_COLS} FROM courier_costs WHERE id = $1 FOR UPDATE`, [costId]);
  const cost = rows[0];
  if (!cost) throw new HttpError(404, 'COST_NOT_FOUND', 'Courier cost not found.');
  if (cost.status !== 'pending') throw new HttpError(409, 'COST_ALREADY_DECIDED', `This cost has already been ${cost.status}.`);
  if (cost.recorded_by === actor.trim()) {
    throw new HttpError(403, 'COST_SELF_APPROVAL', 'A cost must be approved or rejected by someone other than the person who entered it.');
  }
  return cost;
}

/** Approving posts the cost: courier costs expense up, the courier's payable up. */
export async function approveCourierCost(ctx: PayablesCtx, input: { costId: number; actor: string }): Promise<CourierCost> {
  if (!input.actor?.trim()) throw new HttpError(422, 'COST_NO_ACTOR', 'The approver is required.');
  return withTransaction(ctx.pool, async (c) => {
    const cost = await lockPendingCost(c, input.costId, input.actor);
    const { entry } = await postEntryTx(c, {
      description: `Courier cost #${cost.id} approved (${cost.kind}): ${cost.description}`, actor: input.actor,
      orderRef: cost.order_ref, courierId: cost.courier_id, idempotencyKey: `courier-cost:${cost.id}`,
      lines: [dr('COURIER_COSTS', cost.amount_cents), cr('COURIER_PAYABLE', cost.amount_cents)],
    });
    const { rows } = await c.query<CostRow>(
      `UPDATE courier_costs SET status = 'approved', decided_by = $2, decided_at = now(), entry_id = $3 WHERE id = $1 RETURNING ${COST_COLS}`,
      [cost.id, input.actor.trim(), entry.id]);
    return toCost(rows[0]!);
  });
}

export async function rejectCourierCost(ctx: PayablesCtx, input: { costId: number; reason: string; actor: string }): Promise<CourierCost> {
  if (!input.actor?.trim()) throw new HttpError(422, 'COST_NO_ACTOR', 'The person rejecting the cost is required.');
  if (!input.reason?.trim()) throw new HttpError(422, 'COST_REASON_REQUIRED', 'A reason is required to reject a cost.');
  return withTransaction(ctx.pool, async (c) => {
    const cost = await lockPendingCost(c, input.costId, input.actor);
    const { rows } = await c.query<CostRow>(
      `UPDATE courier_costs SET status = 'rejected', decided_by = $2, decided_at = now(), decision_reason = $3 WHERE id = $1 RETURNING ${COST_COLS}`,
      [cost.id, input.actor.trim(), input.reason.trim()]);
    return toCost(rows[0]!);
  });
}

export interface UnpaidItem {
  type: 'package_fee' | 'courier_cost';
  id: number;
  amountCents: number;
  orderRef: string | null;
  since: Date;
  description: string;
}

/** Everything we owe a courier and have not yet paid, oldest first. Zero-amount fees owe nothing and are not listed. */
export async function unpaidItems(db: import('../db/tx.js').Queryable, courierId: number): Promise<UnpaidItem[]> {
  const { rows } = await db.query<{ type: UnpaidItem['type']; id: number; amount: number; order_ref: string | null; since: Date; description: string }>(
    `SELECT 'package_fee' AS type, f.id, f.amount_cents AS amount, f.order_ref, f.recorded_at AS since, 'Package fee' AS description
       FROM package_fees f
      WHERE f.courier_id = $1 AND f.amount_cents > 0 AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.package_fee_id = f.id)
     UNION ALL
     SELECT 'courier_cost', c.id, c.amount_cents, c.order_ref, c.decided_at, 'Courier cost (' || c.kind || '): ' || c.description
       FROM courier_costs c
      WHERE c.courier_id = $1 AND c.status = 'approved' AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.courier_cost_id = c.id)
     ORDER BY since, id`, [courierId]);
  return rows.map((r) => ({ type: r.type, id: r.id, amountCents: r.amount, orderRef: r.order_ref, since: r.since, description: r.description }));
}

export type PayoutMethod = 'mpesa' | 'bank' | 'cash';
// Where the money leaves from. Cash comes out of the till; M-Pesa and bank payments come out of the bank account.
const PAID_FROM = { mpesa: 'BANK', bank: 'BANK', cash: 'TILL' } as const;

export interface Payout { id: number; courierId: number; totalCents: number; method: string; paymentRef: string | null; itemCount: number }

/**
 * Pays a courier. With no items listed it pays everything unpaid; or pass the specific items. Posts one ledger entry
 * (payable down, money out), records the payout with every item as its own line, and closes those items.
 * The total is the sum of the items, never typed in, so it cannot disagree with what is being closed.
 */
export async function createPayout(ctx: PayablesCtx, input: {
  courierId: number; method: PayoutMethod; paymentRef?: string; actor: string;
  items?: { type: 'package_fee' | 'courier_cost'; id: number }[];
}): Promise<Payout> {
  if (!input.actor?.trim()) throw new HttpError(422, 'PAYOUT_NO_ACTOR', 'The person paying is required.');
  if (!(input.method in PAID_FROM)) throw new HttpError(422, 'PAYOUT_BAD_METHOD', 'Pay by mpesa, bank or cash.');
  if (input.method !== 'cash' && !input.paymentRef?.trim()) throw new HttpError(422, 'PAYOUT_REFERENCE_REQUIRED', 'Enter the payment reference (M-Pesa code or bank reference).');

  return withTransaction(ctx.pool, async (c) => {
    // Serialize payouts to one courier, so the same item cannot be paid twice by two people at once.
    const courier = await c.query(`SELECT id FROM couriers WHERE id = $1 FOR UPDATE`, [input.courierId]);
    if (!courier.rows[0]) throw new HttpError(404, 'COURIER_NOT_FOUND', 'Courier not found.');

    const open = await unpaidItems(c, input.courierId);
    let chosen = open;
    if (input.items) {
      chosen = input.items.map((want) => {
        const found = open.find((o) => o.type === want.type && o.id === want.id);
        if (!found) throw new HttpError(409, 'PAYOUT_ITEM_NOT_PAYABLE', `${want.type.replace('_', ' ')} #${want.id} is not an unpaid item for this courier.`);
        return found;
      });
      if (new Set(chosen.map((i) => `${i.type}:${i.id}`)).size !== chosen.length) throw new HttpError(422, 'PAYOUT_DUPLICATE_ITEM', 'An item was listed twice.');
    }
    if (chosen.length === 0) throw new HttpError(409, 'PAYOUT_NOTHING_DUE', 'There is nothing to pay this courier.');

    const total = chosen.reduce((s, i) => s + i.amountCents, 0);
    const { entry } = await postEntryTx(c, {
      description: `Payout to courier ${input.courierId} (${input.method}${input.paymentRef ? ` ${input.paymentRef.trim()}` : ''})`,
      actor: input.actor, courierId: input.courierId,
      lines: [dr('COURIER_PAYABLE', total), cr(PAID_FROM[input.method], total)],
    });
    const payout = await c.query<{ id: number }>(
      `INSERT INTO courier_payouts (courier_id, total_cents, method, payment_ref, paid_by, entry_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.courierId, total, input.method, input.paymentRef?.trim() || null, input.actor.trim(), entry.id]);
    for (const i of chosen) {
      await c.query(`INSERT INTO payout_items (payout_id, package_fee_id, courier_cost_id, amount_cents) VALUES ($1, $2, $3, $4)`,
        [payout.rows[0]!.id, i.type === 'package_fee' ? i.id : null, i.type === 'courier_cost' ? i.id : null, i.amountCents]);
    }
    return { id: payout.rows[0]!.id, courierId: input.courierId, totalCents: total, method: input.method, paymentRef: input.paymentRef?.trim() ?? null, itemCount: chosen.length };
  });
}
