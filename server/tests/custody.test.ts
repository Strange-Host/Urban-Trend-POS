import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { accountBalance } from '../src/ledger/ledger.js';
import { moneyAtRisk } from '../src/orders/atRisk.js';
import { depositCustody, listOpenCustody } from '../src/orders/custody.js';
import { recordShopCash } from '../src/orders/payments.js';
import { makeEnv, newOrder, type Env } from './orderHelpers.js';

let env: Env;
beforeAll(async () => { env = await makeEnv(); });
afterAll(() => env.db.drop());
const ctx = () => ({ pool: env.db.pool });

describe('shop cash custody', () => {
  it('cash taken at the shop is held by a named person until it is deposited', async () => {
    const o = await newOrder(env, { items: [{ name: 'X', quantity: 1, unitPriceCents: 45_000 }] });
    const r = await recordShopCash(ctx(), { orderRef: o.orderRef, amountCents: 45_000, reason: 'Customer came in with cash', actor: 'cashier-amina' });
    const open = await listOpenCustody(env.db.pool);
    expect(open).toEqual([expect.objectContaining({ holder: 'cashier-amina', orderRef: o.orderRef, amountCents: 45_000, receiptNo: r.receiptNo })]);
    expect(await accountBalance(env.db.pool, 'STAFF_CASH_IN_HAND')).toBe(45_000);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);

    const till = await accountBalance(env.db.pool, 'TILL');
    expect(await depositCustody(ctx(), { custodyId: open[0]!.id, actor: 'manager' })).toEqual({ amountCents: 45_000 });
    expect(await accountBalance(env.db.pool, 'STAFF_CASH_IN_HAND')).toBe(0);
    expect(await accountBalance(env.db.pool, 'TILL')).toBe(till + 45_000);
    expect(await listOpenCustody(env.db.pool)).toEqual([]);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('cannot be deposited twice, and a deposited record never changes', async () => {
    const o = await newOrder(env);
    await recordShopCash(ctx(), { orderRef: o.orderRef, amountCents: 10_000, reason: 'in person', actor: 'amina' });
    const rec = (await listOpenCustody(env.db.pool))[0]!;
    await depositCustody(ctx(), { custodyId: rec.id, actor: 'manager' });
    await expect(depositCustody(ctx(), { custodyId: rec.id, actor: 'manager' })).rejects.toMatchObject({ code: 'CUSTODY_ALREADY_DEPOSITED' });
    await expect(env.db.pool.query(`UPDATE custody_records SET status = 'open' WHERE id = $1`, [rec.id])).rejects.toThrow(/never changes/);
    await expect(env.db.pool.query(`UPDATE custody_records SET amount_cents = 1 WHERE id = $1`, [rec.id])).rejects.toThrow();
    await expect(env.db.pool.query(`DELETE FROM custody_records WHERE id = $1`, [rec.id])).rejects.toThrow(/cannot be deleted/);
    await expect(depositCustody(ctx(), { custodyId: 999_999, actor: 'm' })).rejects.toMatchObject({ code: 'CUSTODY_NOT_FOUND' });
    await expect(depositCustody(ctx(), { custodyId: rec.id, actor: ' ' })).rejects.toMatchObject({ code: 'CUSTODY_NO_ACTOR' });
  });

  it('two people depositing the same cash at once deposit it once', async () => {
    const o = await newOrder(env);
    await recordShopCash(ctx(), { orderRef: o.orderRef, amountCents: 12_000, reason: 'in person', actor: 'amina' });
    const rec = (await listOpenCustody(env.db.pool)).find((r) => r.orderRef === o.orderRef)!;
    const till = await accountBalance(env.db.pool, 'TILL');
    const results = await Promise.allSettled([depositCustody(ctx(), { custodyId: rec.id, actor: 'm1' }), depositCustody(ctx(), { custodyId: rec.id, actor: 'm2' })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'CUSTODY_ALREADY_DEPOSITED' });
    expect(await accountBalance(env.db.pool, 'TILL')).toBe(till + 12_000);
  });

  it('cash not deposited for days shows up as money at risk, naming who holds it', async () => {
    const o = await newOrder(env);
    await recordShopCash(ctx(), { orderRef: o.orderRef, amountCents: 8_000, reason: 'in person', actor: 'wafula' });
    expect((await moneyAtRisk(env.db.pool)).some((i) => i.kind === 'cash_not_deposited')).toBe(false); // just taken
    const later = await moneyAtRisk(env.db.pool, { now: new Date(Date.now() + 5 * 86_400_000) });
    expect(later.find((i) => i.kind === 'cash_not_deposited')).toMatchObject({ owner: 'wafula', amountCents: 8_000, orderRef: o.orderRef });
  });
});
