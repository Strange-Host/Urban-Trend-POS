import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { accountBalance, cr, dr, postEntryTx } from '../ledger/ledger.js';
import { resolveOrderRef } from '../ledger/refs.js';
import { shopDate } from '../payroll/time.js';

// Organizations that collect the customer's payment and remit it afterwards (plan path 2).
//   1. recordOrgCollection   the organization collected for an order: customer receivable down, receivable FROM the organization up
//   2. createStatement       a settlement: the organization remits cash, we net off the package fees we owe it, and what is
//                            left (if anything) stays owing. Expected, charged, received and variance are all kept.
// An organization's receivable is read from the ledger and always equals: collected, minus remitted, minus fees netted (Rule 5).

export interface OrgCtx { pool: Pool }

export interface OrgCollection { id: number; courierId: number; orderRef: string; amountCents: number; collectedOn: string; entryId: number }

/** The organization collected `amountCents` from the customer for this order and now holds it. */
export async function recordOrgCollection(ctx: OrgCtx, input: {
  courierId: number; orderRef: string; amountCents: number; collectedOn?: string; actor: string;
}): Promise<OrgCollection> {
  if (!input.actor?.trim()) throw new HttpError(422, 'COLLECTION_NO_ACTOR', 'The person recording this is required.');
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new HttpError(422, 'COLLECTION_BAD_AMOUNT', 'The amount must be a positive whole number of cents.');
  if (input.collectedOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.collectedOn)) throw new HttpError(422, 'COLLECTION_BAD_DATE', 'Use the date format YYYY-MM-DD.');

  return withTransaction(ctx.pool, async (c) => {
    const courier = await c.query<{ kind: string; collects_payment: boolean }>(`SELECT kind, collects_payment FROM couriers WHERE id = $1`, [input.courierId]);
    if (!courier.rows[0]) throw new HttpError(404, 'COURIER_NOT_FOUND', 'Courier not found.');
    if (courier.rows[0].kind !== 'organization' || !courier.rows[0].collects_payment) {
      throw new HttpError(409, 'COLLECTION_NOT_A_COLLECTOR', 'Only an organization that collects payment can collect for an order. Riders never handle customer money.');
    }
    const ref = await resolveOrderRef(c, input.orderRef);
    const order = ref ? (await c.query<{ id: number; order_ref: string; status: string }>(`SELECT id, order_ref, status FROM orders WHERE order_ref = $1 FOR UPDATE`, [ref.ref])).rows[0] : undefined;
    if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    if (order.status !== 'dispatched' && order.status !== 'delivered') {
      throw new HttpError(409, 'COLLECTION_WRONG_STATE', `An order that is ${order.status.replace('_', ' ')} cannot have a collection recorded.`);
    }
    const fee = await c.query<{ courier_id: number }>(`SELECT courier_id FROM package_fees WHERE order_id = $1`, [order.id]);
    if (fee.rows[0]?.courier_id !== input.courierId) {
      throw new HttpError(409, 'COLLECTION_WRONG_COURIER', 'This order was not dispatched with that organization.');
    }
    const balance = Math.max(await accountBalance(c, 'CUSTOMER_RECEIVABLE', { orderRef: order.order_ref }), 0);
    if (input.amountCents > balance) throw new HttpError(422, 'COLLECTION_EXCEEDS_BALANCE', `That is more than the ${balance} cents this order still owes.`);

    const { entry } = await postEntryTx(c, {
      description: `Collected by organization ${input.courierId} for ${order.order_ref}`, actor: input.actor, orderRef: order.order_ref, courierId: input.courierId,
      lines: [dr('ORG_RECEIVABLE', input.amountCents), cr('CUSTOMER_RECEIVABLE', input.amountCents)],
    });
    const { rows } = await c.query<{ id: number; collected_on: string }>(
      `INSERT INTO org_collections (courier_id, order_ref, amount_cents, collected_on, entry_id, recorded_by)
       VALUES ($1, $2, $3, COALESCE($4::date, (now() AT TIME ZONE 'Africa/Nairobi')::date), $5, $6)
       RETURNING id, to_char(collected_on, 'YYYY-MM-DD') AS collected_on`,
      [input.courierId, order.order_ref, input.amountCents, input.collectedOn ?? null, entry.id, input.actor.trim()]);
    await c.query(`INSERT INTO order_events (order_id, order_ref, type, data, actor) VALUES ($1, $2, 'collected_by_organization', $3, $4)`,
      [order.id, order.order_ref, JSON.stringify({ courier_id: input.courierId, amount_cents: input.amountCents }), input.actor]);
    return { id: rows[0]!.id, courierId: input.courierId, orderRef: order.order_ref, amountCents: input.amountCents, collectedOn: rows[0]!.collected_on, entryId: entry.id };
  });
}

export interface Statement {
  id: number;
  courierId: number;
  /** Expected: everything the organization collected on the parcels in this statement. */
  collectionsCents: number;
  /** Charged: the organization's charge as entered by staff, versus our own package fee records. */
  chargeEnteredCents: number;
  feesCents: number;
  /** Received: what the organization actually remitted. */
  remittedCents: number;
  chargeVarianceCents: number;
  /** Expected - our fees - received. Positive means the organization still owes this much. */
  cashVarianceCents: number;
}

/**
 * Settles an organization statement. Lists the parcels it collected for, takes the charge it states and the cash it
 * remitted, and posts: bank up by the cash, courier payable down by OUR package fee records for those parcels (netting),
 * organization receivable down by both. Anything not covered stays owing and shows as variance.
 */
export async function createStatement(ctx: OrgCtx, input: {
  courierId: number; periodStart: string; periodEnd: string; collectionIds: number[];
  chargeEnteredCents: number; remittedCents: number; remittanceRef?: string; actor: string;
}): Promise<Statement> {
  if (!input.actor?.trim()) throw new HttpError(422, 'STATEMENT_NO_ACTOR', 'The person entering the statement is required.');
  for (const [label, v] of [['charge', input.chargeEnteredCents], ['remitted amount', input.remittedCents]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new HttpError(422, 'STATEMENT_BAD_AMOUNT', `The ${label} must be a whole, non-negative number of cents.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(input.periodEnd) || input.periodEnd < input.periodStart) {
    throw new HttpError(422, 'STATEMENT_BAD_PERIOD', 'The period needs a start and an end date (YYYY-MM-DD), end not before start.');
  }
  if (!Array.isArray(input.collectionIds) || input.collectionIds.length === 0) throw new HttpError(422, 'STATEMENT_NO_PARCELS', 'A statement lists the parcels the organization collected for.');
  if (new Set(input.collectionIds).size !== input.collectionIds.length) throw new HttpError(422, 'STATEMENT_DUPLICATE_PARCEL', 'A parcel was listed twice.');

  return withTransaction(ctx.pool, async (c) => {
    const org = await c.query<{ kind: string }>(`SELECT kind FROM couriers WHERE id = $1 FOR UPDATE`, [input.courierId]); // serialize statements per organization
    if (!org.rows[0]) throw new HttpError(404, 'COURIER_NOT_FOUND', 'Courier not found.');
    if (org.rows[0].kind !== 'organization') throw new HttpError(409, 'STATEMENT_NOT_AN_ORGANIZATION', 'Statements are for organizations. Riders are paid by payout.');

    const cols = await c.query<{ id: number; order_ref: string; amount_cents: number; courier_id: number; collected_on: string; on_statement: boolean }>(
      `SELECT k.id, k.order_ref, k.amount_cents, k.courier_id, to_char(k.collected_on, 'YYYY-MM-DD') AS collected_on,
              EXISTS (SELECT 1 FROM org_statement_lines l WHERE l.collection_id = k.id) AS on_statement
         FROM org_collections k WHERE k.id = ANY($1) ORDER BY k.collected_on, k.id`, [input.collectionIds]);
    if (cols.rows.length !== input.collectionIds.length) throw new HttpError(404, 'COLLECTION_NOT_FOUND', 'One of the listed parcels does not exist.');
    for (const k of cols.rows) {
      if (k.courier_id !== input.courierId) throw new HttpError(409, 'STATEMENT_WRONG_ORGANIZATION', `Parcel ${k.order_ref} was collected by a different organization.`);
      if (k.on_statement) throw new HttpError(409, 'STATEMENT_PARCEL_ALREADY_LISTED', `Parcel ${k.order_ref} is already on another statement.`);
      if (k.collected_on > input.periodEnd) throw new HttpError(422, 'STATEMENT_PARCEL_OUTSIDE_PERIOD', `Parcel ${k.order_ref} was collected after the statement period ended.`);
    }
    const collections = cols.rows.reduce((s, k) => s + k.amount_cents, 0);

    // Our own record of what we owe this organization for exactly these parcels.
    const fees = await c.query<{ id: number; amount_cents: number }>(
      `SELECT f.id, f.amount_cents FROM package_fees f
        WHERE f.courier_id = $1 AND f.amount_cents > 0 AND f.order_ref = ANY($2)
          AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.package_fee_id = f.id)
        ORDER BY f.id`, [input.courierId, cols.rows.map((k) => k.order_ref)]);
    const feesTotal = fees.rows.reduce((s, f) => s + f.amount_cents, 0);

    const settled = input.remittedCents + feesTotal;
    if (settled <= 0) throw new HttpError(422, 'STATEMENT_NOTHING_SETTLED', 'Nothing was remitted and no fees are owed on these parcels, so there is nothing to settle.');
    if (settled > collections) {
      throw new HttpError(422, 'STATEMENT_EXCEEDS_COLLECTIONS',
        `The remittance (${input.remittedCents}) plus the fees owed on these parcels (${feesTotal}) is more than the ${collections} they collected.`);
    }

    const lines = [];
    if (input.remittedCents > 0) lines.push(dr('BANK', input.remittedCents));
    if (feesTotal > 0) lines.push(dr('COURIER_PAYABLE', feesTotal));
    lines.push(cr('ORG_RECEIVABLE', settled));
    const { entry } = await postEntryTx(c, {
      description: `Organization statement ${input.periodStart} to ${input.periodEnd}${input.remittanceRef ? ` (${input.remittanceRef.trim()})` : ''}`,
      actor: input.actor, courierId: input.courierId, lines,
    });

    let payoutId: number | null = null;
    if (feesTotal > 0) {
      const p = await c.query<{ id: number }>(
        `INSERT INTO courier_payouts (courier_id, total_cents, method, payment_ref, paid_by, entry_id) VALUES ($1, $2, 'netted_on_remittance', $3, $4, $5) RETURNING id`,
        [input.courierId, feesTotal, input.remittanceRef?.trim() ?? null, input.actor.trim(), entry.id]);
      payoutId = p.rows[0]!.id;
      for (const f of fees.rows) {
        await c.query(`INSERT INTO payout_items (payout_id, package_fee_id, amount_cents) VALUES ($1, $2, $3)`, [payoutId, f.id, f.amount_cents]);
      }
    }

    const chargeVariance = input.chargeEnteredCents - feesTotal;
    const cashVariance = collections - feesTotal - input.remittedCents;
    const st = await c.query<{ id: number }>(
      `INSERT INTO org_statements (courier_id, period_start, period_end, collections_cents, charge_entered_cents, fees_cents, remitted_cents,
                                   charge_variance_cents, cash_variance_cents, remittance_ref, payout_id, entry_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [input.courierId, input.periodStart, input.periodEnd, collections, input.chargeEnteredCents, feesTotal, input.remittedCents,
       chargeVariance, cashVariance, input.remittanceRef?.trim() ?? null, payoutId, entry.id, input.actor.trim()]);
    // What this statement actually secured (cash remitted + fees netted) is credited to its parcels oldest-first, the same
    // order ageing uses. A parcel is fully secure only when covered in full; this is what commission is allowed to count (Rule 8).
    let toSecure = settled;
    for (const k of cols.rows) {
      const secured = Math.min(k.amount_cents, toSecure);
      toSecure -= secured;
      await c.query(`INSERT INTO org_statement_lines (statement_id, collection_id, secured_cents) VALUES ($1, $2, $3)`, [st.rows[0]!.id, k.id, secured]);
    }

    return {
      id: st.rows[0]!.id, courierId: input.courierId, collectionsCents: collections, chargeEnteredCents: input.chargeEnteredCents, feesCents: feesTotal,
      remittedCents: input.remittedCents, chargeVarianceCents: chargeVariance, cashVarianceCents: cashVariance,
    };
  });
}

export interface AgeingBucket { label: '0-7' | '8-14' | '15-30' | '30+'; cents: number }

export interface OrgStanding {
  courierId: number;
  /** What the organization holds and has not remitted: its receivable in the ledger. */
  outstandingCents: number;
  buckets: AgeingBucket[];
  /** The part older than the organization's overdue-after-days. */
  overdueCents: number;
  limitCents: number | null;
  /** True when an overdue balance is above the limit: new collect-on-delivery parcels to this organization are paused. */
  paused: boolean;
}

const bucketFor = (ageDays: number): AgeingBucket['label'] => ageDays <= 7 ? '0-7' : ageDays <= 14 ? '8-14' : ageDays <= 30 ? '15-30' : '30+';

/**
 * Ageing of what an organization holds. Remittances settle the oldest collections first, so what is still
 * outstanding is made up of the newest ones: walk back from the newest until the outstanding amount is used up.
 */
export async function organizationStanding(db: Queryable, courierId: number, now: Date = new Date()): Promise<OrgStanding> {
  const org = await db.query<{ collects_payment: boolean; overdue_limit_cents: number | null; overdue_after_days: number }>(
    `SELECT collects_payment, overdue_limit_cents, overdue_after_days FROM couriers WHERE id = $1 AND kind = 'organization'`, [courierId]);
  if (!org.rows[0]) throw new HttpError(404, 'COURIER_NOT_FOUND', 'Organization not found.');
  const { collects_payment, overdue_limit_cents, overdue_after_days } = org.rows[0];

  const bal = await db.query<{ b: number }>(
    `SELECT COALESCE(sum(l.amount_cents), 0)::bigint AS b FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
      WHERE a.code = 'ORG_RECEIVABLE' AND e.courier_id = $1`, [courierId]);
  const outstanding = Math.max(bal.rows[0]!.b, 0);

  const buckets: Record<AgeingBucket['label'], number> = { '0-7': 0, '8-14': 0, '15-30': 0, '30+': 0 };
  let overdue = 0;
  if (outstanding > 0) {
    const cols = await db.query<{ amount_cents: number; collected_on: string }>(
      `SELECT amount_cents, to_char(collected_on, 'YYYY-MM-DD') AS collected_on FROM org_collections WHERE courier_id = $1 ORDER BY collected_on DESC, id DESC`, [courierId]);
    // Collection dates are the shop's dates (East Africa Time), so "today" must be too: in UTC, between 21:00 and midnight,
    // every balance would look a day younger than it is.
    const today = Date.parse(`${shopDate(now)}T00:00:00Z`);
    let remaining = outstanding;
    for (const k of cols.rows) {
      if (remaining <= 0) break;
      const portion = Math.min(remaining, k.amount_cents);
      remaining -= portion;
      const age = Math.max(0, Math.floor((today - Date.parse(`${k.collected_on}T00:00:00Z`)) / 86_400_000));
      buckets[bucketFor(age)] += portion;
      if (age > overdue_after_days) overdue += portion;
    }
  }
  return {
    courierId, outstandingCents: outstanding,
    buckets: (['0-7', '8-14', '15-30', '30+'] as const).map((label) => ({ label, cents: buckets[label] })),
    overdueCents: overdue, limitCents: overdue_limit_cents,
    paused: collects_payment && overdue_limit_cents !== null && overdue > overdue_limit_cents,
  };
}
