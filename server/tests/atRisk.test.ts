import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchOrder, recordDeliveryAttempt } from '../src/orders/orders.js';
import { moneyAtRisk } from '../src/orders/atRisk.js';
import { ingestPaybillPayment } from '../src/orders/payments.js';
import { makeEnv, newOrder, type Env } from './orderHelpers.js';

let env: Env;
beforeAll(async () => { env = await makeEnv(); });
afterAll(() => env.db.drop());

const days = (n: number) => new Date(Date.now() + n * 86_400_000);

describe('money at risk', () => {
  it('is empty for a healthy, fresh system', async () => {
    const o = await newOrder(env);
    await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'FRESH00001', amountCents: o.totalCents, accountRef: o.orderRef });
    await dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'a' });
    await recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'delivered', actor: 'r' });
    expect(await moneyAtRisk(env.db.pool)).toEqual([]);
    expect(await moneyAtRisk(env.db.pool, { now: days(30) })).toEqual([]); // paid and delivered: never a risk, however old
  });

  it('flags every kind of trouble with its age and amount, oldest first', async () => {
    const stuck = await newOrder(env, { assignedTo: 'dispatcher-1' });                       // dispatched, never heard from
    await dispatchOrder(env.ctx, { orderRef: stuck.orderRef, actor: 'a' });

    const unpaid = await newOrder(env, { items: [{ name: 'X', quantity: 1, unitPriceCents: 120_000 }] }); // delivered, not paid
    await dispatchOrder(env.ctx, { orderRef: unpaid.orderRef, actor: 'a' });
    await recordDeliveryAttempt(env.ctx, { orderRef: unpaid.orderRef, outcome: 'delivered', actor: 'r' });

    const coming = await newOrder(env);                                                        // refused, on its way back
    await dispatchOrder(env.ctx, { orderRef: coming.orderRef, actor: 'a' });
    await recordDeliveryAttempt(env.ctx, { orderRef: coming.orderRef, outcome: 'refused', reason: 'no money', actor: 'r' });

    const paidFine = await newOrder(env);                                                      // fully healthy: must NOT appear
    await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'HEALTHY001', amountCents: paidFine.totalCents, accountRef: paidFine.orderRef });
    await dispatchOrder(env.ctx, { orderRef: paidFine.orderRef, actor: 'a' });
    await recordDeliveryAttempt(env.ctx, { orderRef: paidFine.orderRef, outcome: 'delivered', actor: 'r' });

    await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'LOST000001', amountCents: 7_777, accountRef: 'garbage' }); // unmatched

    const items = await moneyAtRisk(env.db.pool, { now: days(10) });
    const byKind = (k: string) => items.filter((i) => i.kind === k);

    expect(byKind('dispatched_no_outcome')).toEqual([expect.objectContaining({ orderRef: stuck.orderRef, owner: 'dispatcher-1', amountCents: stuck.totalCents })]);
    expect(byKind('delivered_unpaid')).toEqual([expect.objectContaining({ orderRef: unpaid.orderRef, amountCents: 120_000 })]);
    expect(byKind('returning')).toEqual([expect.objectContaining({ orderRef: coming.orderRef })]);
    expect(byKind('unmatched_payment')).toEqual([expect.objectContaining({ amountCents: 7_777, orderRef: null, detail: expect.stringContaining('LOST000001') })]);
    expect(items.map((i) => i.orderRef)).not.toContain(paidFine.orderRef);

    expect(items.every((i) => i.ageDays >= 9)).toBe(true);
    for (let i = 1; i < items.length; i++) expect(items[i - 1]!.ageDays).toBeGreaterThanOrEqual(items[i]!.ageDays);
  });

  it('respects the thresholds: recent items are not flagged yet, but unmatched money always is', async () => {
    const items = await moneyAtRisk(env.db.pool); // now: everything above is minutes old
    expect(items.map((i) => i.kind)).toEqual(['unmatched_payment']);
    const tight = await moneyAtRisk(env.db.pool, { now: days(1), dispatchedNoOutcomeDays: 0, deliveredUnpaidDays: 0, returningDays: 0 });
    expect(new Set(tight.map((i) => i.kind))).toEqual(new Set(['dispatched_no_outcome', 'delivered_unpaid', 'returning', 'unmatched_payment']));
  });

  it('an unmatched payment drops off once it is resolved', async () => {
    const { listSuspense, refundSuspense } = await import('../src/orders/payments.js');
    const item = (await listSuspense(env.db.pool)).find((s) => s.transCode === 'LOST000001')!;
    await refundSuspense({ pool: env.db.pool }, { exceptionId: item.exceptionId, reason: 'returned to payer', actor: 'm' });
    expect((await moneyAtRisk(env.db.pool, { now: days(10) })).some((i) => i.kind === 'unmatched_payment')).toBe(false);
  });
});
