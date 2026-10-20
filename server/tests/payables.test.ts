import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { courierPayableCents, courierProfile } from '../src/couriers/couriers.js';
import { approveCourierCost, createPayout, recordCourierCost, rejectCourierCost, unpaidItems } from '../src/couriers/payables.js';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { accountBalance, getEntry, trialBalance } from '../src/ledger/ledger.js';
import { dispatch, makeEnv, newOrder, newRider, type Env } from './orderHelpers.js';

let env: Env;
beforeAll(async () => { env = await makeEnv(); });
afterAll(() => env.db.drop());
const ctx = () => ({ pool: env.db.pool });

async function riderWithFees(...fees: number[]) {
  const rider = await newRider(env);
  const refs: string[] = [];
  for (const f of fees) {
    const o = await newOrder(env);
    await dispatch(env, o.orderRef, 'dispatcher', { courierId: rider.id, feeCents: f });
    refs.push(o.orderRef);
  }
  return { rider, refs };
}

describe('courier costs: entered, then approved by someone else', () => {
  it('a pending cost owes nothing; approving it posts to courier costs and the same payable balance', async () => {
    const { rider, refs } = await riderWithFees(20_000);
    const cost = await recordCourierCost(ctx(), { courierId: rider.id, kind: 'return_trip', amountCents: 15_000, description: 'Return to shop after refusal', orderRef: refs[0], receiptRef: 'RCPT-77', actor: 'clerk' });
    expect(cost).toMatchObject({ status: 'pending', kind: 'return_trip', orderRef: refs[0], receiptRef: 'RCPT-77' });
    expect(await courierPayableCents(env.db.pool, rider.id)).toBe(20_000); // only the fee so far
    expect(await accountBalance(env.db.pool, 'COURIER_COSTS')).toBe(0);

    const approved = await approveCourierCost(ctx(), { costId: cost.id, actor: 'manager' });
    expect(approved).toMatchObject({ status: 'approved', decidedBy: 'manager' });
    expect(await courierPayableCents(env.db.pool, rider.id)).toBe(35_000);
    expect(await accountBalance(env.db.pool, 'COURIER_COSTS', { orderRef: refs[0] })).toBe(15_000);
  });

  it('keeps package fees and courier costs apart: different accounts, never one entry or one line (Rule 12)', async () => {
    const { rider } = await riderWithFees(10_000);
    const cost = await recordCourierCost(ctx(), { courierId: rider.id, kind: 'fuel', amountCents: 4_000, description: 'Fuel', actor: 'clerk' });
    await approveCourierCost(ctx(), { costId: cost.id, actor: 'manager' });
    const mixed = await env.db.pool.query(
      `SELECT e.id FROM journal_entries e
        WHERE EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = e.id AND a.code = 'COURIER_PACKAGE_FEES')
          AND EXISTS (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = e.id AND a.code = 'COURIER_COSTS')`);
    expect(mixed.rowCount).toBe(0);
    const items = await unpaidItems(env.db.pool, rider.id);
    expect(items.map((i) => i.type)).toEqual(['package_fee', 'courier_cost']);
  });

  it('cannot be approved by the person who entered it', async () => {
    const { rider } = await riderWithFees();
    const cost = await recordCourierCost(ctx(), { courierId: rider.id, kind: 'airtime', amountCents: 500, description: 'Airtime', actor: 'clerk' });
    await expect(approveCourierCost(ctx(), { costId: cost.id, actor: 'clerk' })).rejects.toMatchObject({ code: 'COST_SELF_APPROVAL' });
    await expect(rejectCourierCost(ctx(), { costId: cost.id, reason: 'x', actor: 'clerk' })).rejects.toMatchObject({ code: 'COST_SELF_APPROVAL' });
    // and the database refuses it even if the service is bypassed
    await expect(env.db.pool.query(`UPDATE courier_costs SET status = 'rejected', decided_by = recorded_by, decision_reason = 'x' WHERE id = $1`, [cost.id])).rejects.toThrow(/someone other than/);
  });

  it('a rejected cost needs a reason and never owes anything', async () => {
    const { rider } = await riderWithFees();
    const cost = await recordCourierCost(ctx(), { courierId: rider.id, kind: 'repair', amountCents: 90_000, description: 'Bike repair', actor: 'clerk' });
    await expect(rejectCourierCost(ctx(), { costId: cost.id, reason: ' ', actor: 'manager' })).rejects.toMatchObject({ code: 'COST_REASON_REQUIRED' });
    expect(await rejectCourierCost(ctx(), { costId: cost.id, reason: 'No receipt', actor: 'manager' })).toMatchObject({ status: 'rejected' });
    expect(await courierPayableCents(env.db.pool, rider.id)).toBe(0);
    expect(await unpaidItems(env.db.pool, rider.id)).toEqual([]);
  });

  it('is decided once; a decided cost never changes', async () => {
    const { rider } = await riderWithFees();
    const cost = await recordCourierCost(ctx(), { courierId: rider.id, kind: 'handling', amountCents: 1_000, description: 'Handling', actor: 'clerk' });
    await approveCourierCost(ctx(), { costId: cost.id, actor: 'manager' });
    await expect(approveCourierCost(ctx(), { costId: cost.id, actor: 'manager2' })).rejects.toMatchObject({ code: 'COST_ALREADY_DECIDED' });
    await expect(rejectCourierCost(ctx(), { costId: cost.id, reason: 'changed my mind', actor: 'manager2' })).rejects.toMatchObject({ code: 'COST_ALREADY_DECIDED' });
    await expect(env.db.pool.query(`UPDATE courier_costs SET amount_cents = 1 WHERE id = $1`, [cost.id])).rejects.toThrow(/never changes/);
    await expect(env.db.pool.query(`DELETE FROM courier_costs WHERE id = $1`, [cost.id])).rejects.toThrow(/cannot be deleted/);
  });

  it('two people approving one cost at once post it exactly once', async () => {
    const { rider } = await riderWithFees();
    const cost = await recordCourierCost(ctx(), { courierId: rider.id, kind: 'fuel', amountCents: 7_000, description: 'Fuel', actor: 'clerk' });
    const results = await Promise.allSettled([approveCourierCost(ctx(), { costId: cost.id, actor: 'm1' }), approveCourierCost(ctx(), { costId: cost.id, actor: 'm2' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'COST_ALREADY_DECIDED' });
    expect(await courierPayableCents(env.db.pool, rider.id)).toBe(7_000);
  });

  it('validates what is entered', async () => {
    const { rider } = await riderWithFees();
    const base = { courierId: rider.id, kind: 'fuel' as const, amountCents: 100, description: 'x', actor: 'clerk' };
    await expect(recordCourierCost(ctx(), { ...base, amountCents: 0 })).rejects.toMatchObject({ code: 'COST_BAD_AMOUNT' });
    await expect(recordCourierCost(ctx(), { ...base, amountCents: 1.5 })).rejects.toMatchObject({ code: 'COST_BAD_AMOUNT' });
    await expect(recordCourierCost(ctx(), { ...base, description: ' ' })).rejects.toMatchObject({ code: 'COST_NO_DESCRIPTION' });
    await expect(recordCourierCost(ctx(), { ...base, actor: '' })).rejects.toMatchObject({ code: 'COST_NO_ACTOR' });
    await expect(recordCourierCost(ctx(), { ...base, courierId: 999_999 })).rejects.toMatchObject({ code: 'COURIER_NOT_FOUND' });
    await expect(recordCourierCost(ctx(), { ...base, orderRef: 'UT-22222222' })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    await expect(env.db.pool.query(`INSERT INTO courier_costs (courier_id, kind, amount_cents, description, recorded_by) VALUES ($1, 'bribe', 5, 'x', 't')`, [rider.id])).rejects.toThrow(/check constraint/);
  });
});

describe('payouts close correctly', () => {
  it('pays everything unpaid: one payout, each item its own line, payable back to zero, items closed', async () => {
    const { rider } = await riderWithFees(20_000, 30_000);
    const cost = await recordCourierCost(ctx(), { courierId: rider.id, kind: 'fuel', amountCents: 5_000, description: 'Fuel', actor: 'clerk' });
    await approveCourierCost(ctx(), { costId: cost.id, actor: 'manager' });

    const before = await accountBalance(env.db.pool, 'BANK');
    const payout = await createPayout(ctx(), { courierId: rider.id, method: 'mpesa', paymentRef: 'SBK1234567', actor: 'manager' });
    expect(payout).toMatchObject({ totalCents: 55_000, itemCount: 3, method: 'mpesa', paymentRef: 'SBK1234567' });

    expect(await courierPayableCents(env.db.pool, rider.id)).toBe(0);
    expect(await unpaidItems(env.db.pool, rider.id)).toEqual([]);
    expect(await accountBalance(env.db.pool, 'BANK')).toBe(before - 55_000); // money left the bank
    const lines = (await env.db.pool.query(`SELECT package_fee_id, courier_cost_id FROM payout_items WHERE payout_id = $1 ORDER BY id`, [payout.id])).rows;
    expect(lines.every((l) => (l.package_fee_id === null) !== (l.courier_cost_id === null))).toBe(true); // never a blend
    expect(lines.filter((l) => l.package_fee_id !== null)).toHaveLength(2);
    expect(lines.filter((l) => l.courier_cost_id !== null)).toHaveLength(1);
    expect((await courierProfile(env.db.pool, rider.id)).owedCents).toBe(0);
    expect((await trialBalance(env.db.pool)).totalCents).toBe(0);
  });

  it('can pay chosen items only, and the total is the sum of the items (never typed in)', async () => {
    const { rider } = await riderWithFees(10_000, 20_000, 40_000);
    const items = await unpaidItems(env.db.pool, rider.id);
    const pick = [items[0]!, items[2]!];
    const payout = await createPayout(ctx(), { courierId: rider.id, method: 'bank', paymentRef: 'BNK-1', actor: 'm', items: pick.map((i) => ({ type: i.type, id: i.id })) });
    expect(payout.totalCents).toBe(50_000);
    expect(await courierPayableCents(env.db.pool, rider.id)).toBe(20_000);
    expect((await unpaidItems(env.db.pool, rider.id)).map((i) => i.amountCents)).toEqual([20_000]);
  });

  it('cash comes out of the till; a payment by M-Pesa or bank needs a reference', async () => {
    const { rider } = await riderWithFees(8_000);
    await expect(createPayout(ctx(), { courierId: rider.id, method: 'mpesa', actor: 'm' })).rejects.toMatchObject({ code: 'PAYOUT_REFERENCE_REQUIRED' });
    await expect(createPayout(ctx(), { courierId: rider.id, method: 'bank', paymentRef: '  ', actor: 'm' })).rejects.toMatchObject({ code: 'PAYOUT_REFERENCE_REQUIRED' });
    const till = await accountBalance(env.db.pool, 'TILL');
    await createPayout(ctx(), { courierId: rider.id, method: 'cash', actor: 'm' });
    expect(await accountBalance(env.db.pool, 'TILL')).toBe(till - 8_000);
    // @ts-expect-error: not a real method
    await expect(createPayout(ctx(), { courierId: rider.id, method: 'barter', actor: 'm' })).rejects.toMatchObject({ code: 'PAYOUT_BAD_METHOD' });
    await expect(createPayout(ctx(), { courierId: rider.id, method: 'cash', actor: '' })).rejects.toMatchObject({ code: 'PAYOUT_NO_ACTOR' });
  });

  it('refuses when there is nothing to pay, an item that is not payable, a repeated item, and an unknown courier', async () => {
    const { rider } = await riderWithFees(5_000);
    await expect(createPayout(ctx(), { courierId: rider.id, method: 'cash', actor: 'm', items: [{ type: 'package_fee', id: 999_999 }] })).rejects.toMatchObject({ code: 'PAYOUT_ITEM_NOT_PAYABLE' });
    const item = (await unpaidItems(env.db.pool, rider.id))[0]!;
    await expect(createPayout(ctx(), { courierId: rider.id, method: 'cash', actor: 'm', items: [{ type: item.type, id: item.id }, { type: item.type, id: item.id }] })).rejects.toMatchObject({ code: 'PAYOUT_DUPLICATE_ITEM' });
    await createPayout(ctx(), { courierId: rider.id, method: 'cash', actor: 'm' });
    await expect(createPayout(ctx(), { courierId: rider.id, method: 'cash', actor: 'm' })).rejects.toMatchObject({ code: 'PAYOUT_NOTHING_DUE' });
    await expect(createPayout(ctx(), { courierId: 999_999, method: 'cash', actor: 'm' })).rejects.toMatchObject({ code: 'COURIER_NOT_FOUND' });
  });

  it('cannot pay another courier\'s item, or the same item twice', async () => {
    const a = await riderWithFees(11_000);
    const b = await riderWithFees(13_000);
    const aItem = (await unpaidItems(env.db.pool, a.rider.id))[0]!;
    await expect(createPayout(ctx(), { courierId: b.rider.id, method: 'cash', actor: 'm', items: [{ type: aItem.type, id: aItem.id }] })).rejects.toMatchObject({ code: 'PAYOUT_ITEM_NOT_PAYABLE' });
    await createPayout(ctx(), { courierId: a.rider.id, method: 'cash', actor: 'm' });
    await expect(env.db.pool.query(`INSERT INTO payout_items (payout_id, package_fee_id, amount_cents) SELECT payout_id, package_fee_id, amount_cents FROM payout_items WHERE package_fee_id = $1`, [aItem.id])).rejects.toThrow(/duplicate key/);
  });

  it('two people paying one courier at once pay each item exactly once', async () => {
    const { rider } = await riderWithFees(10_000, 20_000);
    const results = await Promise.allSettled([
      createPayout(ctx(), { courierId: rider.id, method: 'cash', actor: 'm1' }),
      createPayout(ctx(), { courierId: rider.id, method: 'cash', actor: 'm2' }),
      createPayout(ctx(), { courierId: rider.id, method: 'cash', actor: 'm3' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ totalCents: number }>).value.totalCents).toBe(30_000);
    // The ones that lose get a clear business answer, not a raw database error (the unique constraint is only the backstop).
    for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'PAYOUT_NOTHING_DUE' });
    expect(await courierPayableCents(env.db.pool, rider.id)).toBe(0);
  });

  it('a zero fee owes nothing and is not payable', async () => {
    const rider = await newRider(env);
    const o = await newOrder(env);
    await dispatch(env, o.orderRef, 'a', { courierId: rider.id, feeCents: 0, zeroReason: 'Delivered by the owner' });
    expect(await unpaidItems(env.db.pool, rider.id)).toEqual([]);
    await expect(createPayout(ctx(), { courierId: rider.id, method: 'cash', actor: 'm' })).rejects.toMatchObject({ code: 'PAYOUT_NOTHING_DUE' });
  });

  it('payouts, their lines, and their ledger entries cannot be edited or deleted', async () => {
    const { rider } = await riderWithFees(3_000);
    const p = await createPayout(ctx(), { courierId: rider.id, method: 'cash', actor: 'm' });
    await expect(env.db.pool.query(`UPDATE courier_payouts SET total_cents = 1 WHERE id = $1`, [p.id])).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`DELETE FROM payout_items WHERE payout_id = $1`, [p.id])).rejects.toThrow(/immutable/);
    const entry = (await env.db.pool.query(`SELECT entry_id FROM courier_payouts WHERE id = $1`, [p.id])).rows[0].entry_id;
    expect((await getEntry(env.db.pool, entry))!.courierId).toBe(rider.id);
  });

  it('Rule 4 holds throughout: the ledger payable always equals what is earned and unpaid', async () => {
    const { rider } = await riderWithFees(10_000, 25_000, 15_000);
    const cost = await recordCourierCost(ctx(), { courierId: rider.id, kind: 'fuel', amountCents: 2_000, description: 'f', actor: 'clerk' });
    await approveCourierCost(ctx(), { costId: cost.id, actor: 'manager' });
    const pending = await recordCourierCost(ctx(), { courierId: rider.id, kind: 'fuel', amountCents: 9_999, description: 'not yet approved', actor: 'clerk' });
    expect(pending.status).toBe('pending');
    const unpaidSum = async () => (await unpaidItems(env.db.pool, rider.id)).reduce((s, i) => s + i.amountCents, 0);
    expect(await courierPayableCents(env.db.pool, rider.id)).toBe(await unpaidSum());
    const first = (await unpaidItems(env.db.pool, rider.id))[0]!;
    await createPayout(ctx(), { courierId: rider.id, method: 'cash', actor: 'm', items: [{ type: first.type, id: first.id }] });
    expect(await courierPayableCents(env.db.pool, rider.id)).toBe(await unpaidSum());
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });
});
