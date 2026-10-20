import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { courierPayableCents } from '../src/couriers/couriers.js';
import { createStatement, organizationStanding, recordOrgCollection } from '../src/couriers/organizations.js';
import { createPayout, unpaidItems } from '../src/couriers/payables.js';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { accountBalance, trialBalance } from '../src/ledger/ledger.js';
import { getOrderTx, recordDeliveryAttempt } from '../src/orders/orders.js';
import { dispatch, makeEnv, newOrder, newOrg, newRider, type Env } from './orderHelpers.js';

let env: Env;
beforeAll(async () => { env = await makeEnv(); });
afterAll(() => env.db.drop());
const ctx = () => ({ pool: env.db.pool });
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const today = () => ago(0);

// An order of `total` cents, dispatched with `courierId` at `fee`.
async function dispatched(courierId: number, total = 100_000, fee = 20_000) {
  const o = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: total }] });
  await dispatch(env, o.orderRef, 'dispatcher', { courierId, feeCents: fee });
  return o;
}

describe('an organization collects the customer\'s payment', () => {
  it('moves the money from the customer\'s account to the organization\'s: the order counts as paid, but not yet in the shop\'s hands', async () => {
    const org = await newOrg(env);
    const o = await dispatched(org.id, 100_000);
    const c = await recordOrgCollection(ctx(), { courierId: org.id, orderRef: o.orderRef, amountCents: 100_000, actor: 'clerk' });
    expect(c).toMatchObject({ orderRef: o.orderRef, amountCents: 100_000, courierId: org.id });
    const v = (await getOrderTx(env.db.pool, o.orderRef))!;
    expect(v).toMatchObject({ balanceCents: 0, paidCents: 100_000, collectedByOrganizationCents: 100_000, paymentStatus: 'paid' });
    expect(await accountBalance(env.db.pool, 'ORG_RECEIVABLE', { orderRef: o.orderRef })).toBe(100_000);
    expect(v.events.map((e) => e.type)).toContain('collected_by_organization');
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('allows a part collection, then the rest, but never more than is owed', async () => {
    const org = await newOrg(env);
    const o = await dispatched(org.id, 100_000);
    await recordOrgCollection(ctx(), { courierId: org.id, orderRef: o.orderRef, amountCents: 60_000, actor: 'c' });
    expect((await getOrderTx(env.db.pool, o.orderRef))!.paymentStatus).toBe('part_paid');
    await expect(recordOrgCollection(ctx(), { courierId: org.id, orderRef: o.orderRef, amountCents: 40_001, actor: 'c' })).rejects.toMatchObject({ code: 'COLLECTION_EXCEEDS_BALANCE' });
    await recordOrgCollection(ctx(), { courierId: org.id, orderRef: o.orderRef, amountCents: 40_000, actor: 'c' });
    expect((await getOrderTx(env.db.pool, o.orderRef))!.paymentStatus).toBe('paid');
  });

  it('only an organization that collects can collect; riders never handle customer money', async () => {
    const rider = await newRider(env);
    const nonCollecting = await newOrg(env, { collectsPayment: false });
    const a = await dispatched(rider.id);
    const b = await dispatched(nonCollecting.id);
    await expect(recordOrgCollection(ctx(), { courierId: rider.id, orderRef: a.orderRef, amountCents: 1, actor: 'c' })).rejects.toMatchObject({ code: 'COLLECTION_NOT_A_COLLECTOR' });
    await expect(recordOrgCollection(ctx(), { courierId: nonCollecting.id, orderRef: b.orderRef, amountCents: 1, actor: 'c' })).rejects.toMatchObject({ code: 'COLLECTION_NOT_A_COLLECTOR' });
  });

  it('must be the organization the order was dispatched with, and the order must be out for delivery', async () => {
    const org = await newOrg(env);
    const other = await newOrg(env);
    const o = await dispatched(org.id);
    await expect(recordOrgCollection(ctx(), { courierId: other.id, orderRef: o.orderRef, amountCents: 1, actor: 'c' })).rejects.toMatchObject({ code: 'COLLECTION_WRONG_COURIER' });
    const notYet = await newOrder(env);
    await expect(recordOrgCollection(ctx(), { courierId: org.id, orderRef: notYet.orderRef, amountCents: 1, actor: 'c' })).rejects.toMatchObject({ code: 'COLLECTION_WRONG_STATE' });
    await expect(recordOrgCollection(ctx(), { courierId: org.id, orderRef: 'UT-22222222', amountCents: 1, actor: 'c' })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    await expect(recordOrgCollection(ctx(), { courierId: 999_999, orderRef: o.orderRef, amountCents: 1, actor: 'c' })).rejects.toMatchObject({ code: 'COURIER_NOT_FOUND' });
  });

  it('validates the amount, the date and who recorded it; records cannot be edited', async () => {
    const org = await newOrg(env);
    const o = await dispatched(org.id);
    const base = { courierId: org.id, orderRef: o.orderRef, amountCents: 1_000, actor: 'c' };
    await expect(recordOrgCollection(ctx(), { ...base, amountCents: 0 })).rejects.toMatchObject({ code: 'COLLECTION_BAD_AMOUNT' });
    await expect(recordOrgCollection(ctx(), { ...base, collectedOn: '1/2/2026' })).rejects.toMatchObject({ code: 'COLLECTION_BAD_DATE' });
    await expect(recordOrgCollection(ctx(), { ...base, actor: ' ' })).rejects.toMatchObject({ code: 'COLLECTION_NO_ACTOR' });
    await recordOrgCollection(ctx(), base);
    await expect(env.db.pool.query(`UPDATE org_collections SET amount_cents = 1`)).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`DELETE FROM org_collections`)).rejects.toThrow(/immutable/);
  });
});

describe('statements: the organization remits, and the fees we owe it are netted off', () => {
  async function threeParcels(org: { id: number }) {
    const orders = [await dispatched(org.id, 100_000, 20_000), await dispatched(org.id, 150_000, 20_000), await dispatched(org.id, 80_000, 20_000)];
    const cols = [];
    for (const o of orders) cols.push(await recordOrgCollection(ctx(), { courierId: org.id, orderRef: o.orderRef, amountCents: o.totalCents, collectedOn: today(), actor: 'clerk' }));
    return { orders, cols };
  }

  it('ORGANIZATION REMITTANCE CLOSES CORRECTLY: collected 330,000, fees 60,000, remitted 270,000 -> nothing owing either way', async () => {
    const org = await newOrg(env);
    const { cols } = await threeParcels(org);
    expect(await accountBalance(env.db.pool, 'ORG_RECEIVABLE')).toBeGreaterThanOrEqual(330_000);
    expect(await courierPayableCents(env.db.pool, org.id)).toBe(60_000);
    const bankBefore = await accountBalance(env.db.pool, 'BANK');

    const st = await createStatement(ctx(), {
      courierId: org.id, periodStart: ago(7), periodEnd: today(), collectionIds: cols.map((c) => c.id),
      chargeEnteredCents: 60_000, remittedCents: 270_000, remittanceRef: 'EFT-5521', actor: 'manager',
    });
    expect(st).toMatchObject({ collectionsCents: 330_000, chargeEnteredCents: 60_000, feesCents: 60_000, remittedCents: 270_000, chargeVarianceCents: 0, cashVarianceCents: 0 });

    expect((await organizationStanding(env.db.pool, org.id)).outstandingCents).toBe(0);   // Rule 5: nothing held
    expect(await courierPayableCents(env.db.pool, org.id)).toBe(0);                         // Rule 4: fees netted, so nothing owed
    expect(await unpaidItems(env.db.pool, org.id)).toEqual([]);
    expect(await accountBalance(env.db.pool, 'BANK')).toBe(bankBefore + 270_000);          // only the cash actually received
    const payout = (await env.db.pool.query(`SELECT method, total_cents FROM courier_payouts WHERE courier_id = $1`, [org.id])).rows[0];
    expect(payout).toEqual({ method: 'netted_on_remittance', total_cents: 60_000 });
    expect((await trialBalance(env.db.pool)).totalCents).toBe(0);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('a short remittance is not hidden: the shortfall stays owing and shows as variance', async () => {
    const org = await newOrg(env);
    const { cols } = await threeParcels(org);
    const st = await createStatement(ctx(), { courierId: org.id, periodStart: ago(7), periodEnd: today(), collectionIds: cols.map((c) => c.id), chargeEnteredCents: 60_000, remittedCents: 200_000, actor: 'm' });
    expect(st.cashVarianceCents).toBe(70_000); // expected 330k - fees 60k - received 200k
    expect((await organizationStanding(env.db.pool, org.id)).outstandingCents).toBe(70_000);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('when the organization\'s stated charge differs from our fee records, both are kept and the books follow OUR records', async () => {
    const org = await newOrg(env);
    const { cols } = await threeParcels(org);
    const st = await createStatement(ctx(), { courierId: org.id, periodStart: ago(7), periodEnd: today(), collectionIds: cols.map((c) => c.id), chargeEnteredCents: 75_000, remittedCents: 270_000, actor: 'm' });
    expect(st).toMatchObject({ chargeEnteredCents: 75_000, feesCents: 60_000, chargeVarianceCents: 15_000, cashVarianceCents: 0 });
    expect(await courierPayableCents(env.db.pool, org.id)).toBe(0);
  });

  it('nets only the fees for the parcels on the statement; other fees stay payable the normal way', async () => {
    const org = await newOrg(env);
    const { cols } = await threeParcels(org);
    await dispatched(org.id, 50_000, 15_000); // dispatched, not collected, not on the statement
    await createStatement(ctx(), { courierId: org.id, periodStart: ago(7), periodEnd: today(), collectionIds: cols.map((c) => c.id), chargeEnteredCents: 60_000, remittedCents: 270_000, actor: 'm' });
    expect(await courierPayableCents(env.db.pool, org.id)).toBe(15_000);
    const pay = await createPayout(ctx(), { courierId: org.id, method: 'bank', paymentRef: 'BNK-9', actor: 'm' });
    expect(pay.totalCents).toBe(15_000);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('a parcel appears on one statement only, and only for its own organization and period', async () => {
    const org = await newOrg(env);
    const other = await newOrg(env);
    const { cols } = await threeParcels(org);
    const base = { courierId: org.id, periodStart: ago(7), periodEnd: today(), chargeEnteredCents: 0, remittedCents: 10_000, actor: 'm' };
    await createStatement(ctx(), { ...base, collectionIds: [cols[0]!.id] });
    await expect(createStatement(ctx(), { ...base, collectionIds: [cols[0]!.id] })).rejects.toMatchObject({ code: 'STATEMENT_PARCEL_ALREADY_LISTED' });
    await expect(createStatement(ctx(), { ...base, courierId: other.id, collectionIds: [cols[1]!.id] })).rejects.toMatchObject({ code: 'STATEMENT_WRONG_ORGANIZATION' });
    await expect(createStatement(ctx(), { ...base, periodEnd: ago(3), periodStart: ago(5), collectionIds: [cols[1]!.id] })).rejects.toMatchObject({ code: 'STATEMENT_PARCEL_OUTSIDE_PERIOD' });
    await expect(env.db.pool.query(`INSERT INTO org_statement_lines (statement_id, collection_id) SELECT statement_id, collection_id FROM org_statement_lines LIMIT 1`)).rejects.toThrow(/duplicate key/);
  });

  it('refuses a statement that settles more than was collected, settles nothing, or is malformed', async () => {
    const org = await newOrg(env);
    const { cols } = await threeParcels(org);
    const ids = cols.map((c) => c.id);
    const base = { courierId: org.id, periodStart: ago(7), periodEnd: today(), collectionIds: ids, chargeEnteredCents: 60_000, actor: 'm' };
    await expect(createStatement(ctx(), { ...base, remittedCents: 270_001 })).rejects.toMatchObject({ code: 'STATEMENT_EXCEEDS_COLLECTIONS' });
    await expect(createStatement(ctx(), { ...base, collectionIds: [] , remittedCents: 1 })).rejects.toMatchObject({ code: 'STATEMENT_NO_PARCELS' });
    await expect(createStatement(ctx(), { ...base, collectionIds: [ids[0]!, ids[0]!], remittedCents: 1 })).rejects.toMatchObject({ code: 'STATEMENT_DUPLICATE_PARCEL' });
    await expect(createStatement(ctx(), { ...base, collectionIds: [999_999], remittedCents: 1 })).rejects.toMatchObject({ code: 'COLLECTION_NOT_FOUND' });
    await expect(createStatement(ctx(), { ...base, periodStart: ago(1), periodEnd: ago(5), remittedCents: 1 })).rejects.toMatchObject({ code: 'STATEMENT_BAD_PERIOD' });
    await expect(createStatement(ctx(), { ...base, remittedCents: -1 })).rejects.toMatchObject({ code: 'STATEMENT_BAD_AMOUNT' });
    await expect(createStatement(ctx(), { ...base, actor: '' , remittedCents: 1 })).rejects.toMatchObject({ code: 'STATEMENT_NO_ACTOR' });
    // a parcel with no fee owed and nothing remitted settles nothing
    const feeless = await newOrg(env);
    const o = await newOrder(env);
    await dispatch(env, o.orderRef, 'a', { courierId: feeless.id, feeCents: 0, zeroReason: 'agreed' });
    const col = await recordOrgCollection(ctx(), { courierId: feeless.id, orderRef: o.orderRef, amountCents: 10_000, actor: 'c' });
    await expect(createStatement(ctx(), { courierId: feeless.id, periodStart: ago(1), periodEnd: today(), collectionIds: [col.id], chargeEnteredCents: 0, remittedCents: 0, actor: 'm' })).rejects.toMatchObject({ code: 'STATEMENT_NOTHING_SETTLED' });
    // nothing was half-posted by any refusal
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('riders are paid by payout, not statement; statements, lines and the netting record cannot be edited', async () => {
    const rider = await newRider(env);
    await expect(createStatement(ctx(), { courierId: rider.id, periodStart: ago(1), periodEnd: today(), collectionIds: [1], chargeEnteredCents: 0, remittedCents: 1, actor: 'm' })).rejects.toMatchObject({ code: 'STATEMENT_NOT_AN_ORGANIZATION' });
    await expect(env.db.pool.query(`UPDATE org_statements SET remitted_cents = 1`)).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`DELETE FROM org_statement_lines`)).rejects.toThrow(/immutable/);
  });

  it('two statements racing for the same parcels settle them once', async () => {
    const org = await newOrg(env);
    const { cols } = await threeParcels(org);
    const attempt = (actor: string) => createStatement(ctx(), { courierId: org.id, periodStart: ago(7), periodEnd: today(), collectionIds: cols.map((c) => c.id), chargeEnteredCents: 60_000, remittedCents: 270_000, actor });
    const results = await Promise.allSettled([attempt('m1'), attempt('m2'), attempt('m3')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'STATEMENT_PARCEL_ALREADY_LISTED' });
    expect((await organizationStanding(env.db.pool, org.id)).outstandingCents).toBe(0);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });
});

describe('ageing and the pause rule', () => {
  // Four 100,000 collections aged 2, 10, 25 and 60 days.
  async function agedOrg(limit?: number) {
    const org = await newOrg(env, { overdueLimitCents: limit, overdueAfterDays: 14 });
    const cols = [];
    for (const age of [2, 10, 25, 60]) {
      const o = await dispatched(org.id, 100_000, 10_000);
      cols.push(await recordOrgCollection(ctx(), { courierId: org.id, orderRef: o.orderRef, amountCents: 100_000, collectedOn: ago(age), actor: 'c' }));
    }
    return { org, cols };
  }

  it('buckets what the organization holds by age (0-7, 8-14, 15-30, over 30) and totals the overdue part', async () => {
    const { org } = await agedOrg(150_000);
    const s = await organizationStanding(env.db.pool, org.id);
    expect(s.outstandingCents).toBe(400_000);
    expect(s.buckets).toEqual([{ label: '0-7', cents: 100_000 }, { label: '8-14', cents: 100_000 }, { label: '15-30', cents: 100_000 }, { label: '30+', cents: 100_000 }]);
    expect(s.overdueCents).toBe(200_000); // the 25- and 60-day collections are past 14 days
    expect(s.paused).toBe(true);          // 200,000 overdue is above the 150,000 limit
  });

  it('a remittance settles the OLDEST money first, so the ageing improves', async () => {
    const { org, cols } = await agedOrg(150_000);
    await createStatement(ctx(), { courierId: org.id, periodStart: ago(70), periodEnd: today(), collectionIds: [cols[3]!.id], chargeEnteredCents: 10_000, remittedCents: 90_000, actor: 'm' });
    const s = await organizationStanding(env.db.pool, org.id);
    expect(s.outstandingCents).toBe(300_000);
    expect(s.buckets.find((b) => b.label === '30+')!.cents).toBe(0);
    expect(s.overdueCents).toBe(100_000);
    expect(s.paused).toBe(false); // back under the limit
  });

  it('PAUSES new collect-on-delivery parcels while overdue money is above the limit, and releases them when it remits', async () => {
    const { org, cols } = await agedOrg(150_000);
    const next = await newOrder(env);
    await expect(dispatch(env, next.orderRef, 'a', { courierId: org.id })).rejects.toMatchObject({ code: 'ORG_PAUSED', details: { limitCents: 150_000 } });
    expect((await getOrderTx(env.db.pool, next.orderRef))!.status).toBe('awaiting_dispatch');

    await createStatement(ctx(), { courierId: org.id, periodStart: ago(70), periodEnd: today(), collectionIds: [cols[3]!.id], chargeEnteredCents: 10_000, remittedCents: 90_000, actor: 'm' });
    expect((await dispatch(env, next.orderRef, 'a', { courierId: org.id })).status).toBe('dispatched');
  });

  it('never pauses an organization with no limit set, or one that does not collect; riders are never affected', async () => {
    const { org } = await agedOrg(undefined);
    expect((await organizationStanding(env.db.pool, org.id)).paused).toBe(false);
    const o = await newOrder(env);
    expect((await dispatch(env, o.orderRef, 'a', { courierId: org.id })).status).toBe('dispatched');

    const nonCollecting = await newOrg(env, { collectsPayment: false, overdueLimitCents: 1 });
    const p = await newOrder(env);
    expect((await dispatch(env, p.orderRef, 'a', { courierId: nonCollecting.id })).status).toBe('dispatched');
  });

  it('an organization with nothing outstanding has an empty ageing; an unknown one is a 404', async () => {
    const org = await newOrg(env);
    expect(await organizationStanding(env.db.pool, org.id)).toMatchObject({ outstandingCents: 0, overdueCents: 0, paused: false });
    await expect(organizationStanding(env.db.pool, 999_999)).rejects.toMatchObject({ code: 'COURIER_NOT_FOUND' });
    const rider = await newRider(env);
    await expect(organizationStanding(env.db.pool, rider.id)).rejects.toMatchObject({ code: 'COURIER_NOT_FOUND' });
  });
});

describe('a delivered organization parcel, end to end', () => {
  it('delivered by the organization, collected, settled: the order, the fee and the cash all close', async () => {
    const org = await newOrg(env);
    const o = await dispatched(org.id, 120_000, 25_000);
    await recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'delivered', actor: 'clerk' });
    const col = await recordOrgCollection(ctx(), { courierId: org.id, orderRef: o.orderRef, amountCents: 120_000, actor: 'clerk' });
    await createStatement(ctx(), { courierId: org.id, periodStart: ago(1), periodEnd: today(), collectionIds: [col.id], chargeEnteredCents: 25_000, remittedCents: 95_000, actor: 'manager' });
    const v = (await getOrderTx(env.db.pool, o.orderRef))!;
    expect([v.status, v.paymentStatus, v.balanceCents]).toEqual(['delivered', 'paid', 0]);
    expect(await courierPayableCents(env.db.pool, org.id)).toBe(0);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });
});
