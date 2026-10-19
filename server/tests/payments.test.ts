import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { accountBalance, trialBalance } from '../src/ledger/ledger.js';
import { dispatchOrder, getOrderTx, recordDeliveryAttempt, cancelOrder } from '../src/orders/orders.js';
import { applySuspenseToOrder, ingestPaybillPayment, listSuspense, recordShopCash, refundSuspense, suggestMatches } from '../src/orders/payments.js';
import { makeEnv, newOrder, freshPhone, type Env } from './orderHelpers.js';

let env: Env;
beforeAll(async () => { env = await makeEnv(); });
afterAll(() => env.db.drop());

let n = 0;
const code = () => `QX${String(1_000_000 + n++)}`; // unique M-Pesa-style transaction code per test payment
const pay = (over: Partial<Parameters<typeof ingestPaybillPayment>[1]> & { amountCents: number }) =>
  ingestPaybillPayment({ pool: env.db.pool }, { transCode: code(), ...over });
const order = (cents = 100_000, over = {}) => newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: cents }], ...over });

describe('PHASE 3 DONE WHEN: a test order runs from creation to a matched paybill payment', () => {
  it('create -> pay by reference -> receipt -> dispatch -> deliver, with a clean integrity check', async () => {
    const created = await order(250_000);
    expect(created.paymentStatus).toBe('unpaid');

    // The customer types the reference into the paybill account field however they like.
    const typed = ` ${created.orderRef.toLowerCase().replace('-', ' ')} `;
    const paid = await pay({ amountCents: 250_000, accountRef: typed, msisdn: '254712345678', payerName: 'WANJIKU W' });
    expect(paid).toMatchObject({ outcome: 'applied', orderRef: created.orderRef, appliedCents: 250_000, suspenseCents: 0, duplicate: false });
    expect(paid.receiptNo).toMatch(/^RC-\d{4}-000\d{3}$/);

    const afterPay = (await getOrderTx(env.db.pool, created.orderRef))!;
    expect(afterPay.paymentStatus).toBe('paid');
    expect(afterPay.balanceCents).toBe(0);
    expect(afterPay.paidCents).toBe(250_000);
    expect(afterPay.events.map((e) => e.type)).toEqual(['created', 'payment_received']);

    await dispatchOrder(env.ctx, { orderRef: created.orderRef, actor: 'dispatcher' });
    const delivered = await recordDeliveryAttempt(env.ctx, { orderRef: created.orderRef, outcome: 'delivered', actor: 'rider' });
    expect(delivered.status).toBe('delivered');
    expect(delivered.paymentStatus).toBe('paid');

    expect(await accountBalance(env.db.pool, 'PAYBILL_CLEARING', { orderRef: created.orderRef })).toBe(250_000);
    expect((await trialBalance(env.db.pool)).totalCents).toBe(0);
    const report = await runIntegrityChecks(env.db.pool);
    expect(report.violations).toEqual([]);
  });
});

describe('matching rules', () => {
  it('rule 1, exact: reference found and the amount equals what is owed', async () => {
    const o = await order(80_000);
    const r = await pay({ amountCents: 80_000, accountRef: o.orderRef });
    expect(r.outcome).toBe('applied');
  });

  it('rule 2, part payment: the balance goes down, each payment is receipted, and the order is paid when they add up', async () => {
    const o = await order(100_000);
    const first = await pay({ amountCents: 30_000, accountRef: o.orderRef });
    expect(first).toMatchObject({ outcome: 'part_paid', appliedCents: 30_000, suspenseCents: 0 });
    let view = (await getOrderTx(env.db.pool, o.orderRef))!;
    expect([view.paymentStatus, view.balanceCents, view.paidCents]).toEqual(['part_paid', 70_000, 30_000]);

    const second = await pay({ amountCents: 70_000, accountRef: o.orderRef });
    expect(second.outcome).toBe('applied');
    view = (await getOrderTx(env.db.pool, o.orderRef))!;
    expect([view.paymentStatus, view.balanceCents, view.paidCents]).toEqual(['paid', 0, 100_000]);
    expect(first.receiptNo).not.toBe(second.receiptNo);
  });

  it('rule 3, excess: the owed part is applied, the rest waits in suspense, and only the applied part is receipted', async () => {
    const o = await order(100_000);
    const r = await pay({ amountCents: 130_000, accountRef: o.orderRef, msisdn: '0700111222' });
    expect(r).toMatchObject({ outcome: 'excess', appliedCents: 100_000, suspenseCents: 30_000 });
    const view = (await getOrderTx(env.db.pool, o.orderRef))!;
    expect([view.paymentStatus, view.paidCents, view.balanceCents]).toEqual(['paid', 100_000, 0]); // never paid past what it owes
    const item = (await listSuspense(env.db.pool)).find((s) => s.transCode === r.transCode)!;
    expect(item).toMatchObject({ kind: 'excess', amountCents: 30_000, remainingCents: 30_000, intendedOrderRef: o.orderRef });
  });

  it('rule 3, an order that is already paid: the whole payment goes to suspense, with no receipt', async () => {
    const o = await order(50_000);
    await pay({ amountCents: 50_000, accountRef: o.orderRef });
    const again = await pay({ amountCents: 50_000, accountRef: o.orderRef });
    expect(again).toMatchObject({ outcome: 'excess', appliedCents: 0, suspenseCents: 50_000, receiptNo: null });
    expect((await getOrderTx(env.db.pool, o.orderRef))!.paidCents).toBe(50_000);
  });

  it('rule 4, no reference or a wrong one: everything goes to suspense, tied to no order', async () => {
    const o = await order(40_000);
    const bad = o.orderRef.slice(0, -1) + (o.orderRef.endsWith('2') ? '3' : '2'); // one typo: the check character fails
    for (const accountRef of [undefined, '', 'rent', bad, 'UT-22222222', 'UT999999']) {
      const r = await pay({ amountCents: 12_345, accountRef });
      expect(r, String(accountRef)).toMatchObject({ outcome: 'suspense', orderRef: null, appliedCents: 0, suspenseCents: 12_345, receiptNo: null });
    }
    expect((await getOrderTx(env.db.pool, o.orderRef))!.balanceCents).toBe(40_000); // the real order was not touched by the typo
  });

  it('an old-style code typed as the account still matches', async () => {
    const o = await order(70_000, { legacyRef: 'UT004321' });
    expect((await pay({ amountCents: 70_000, accountRef: 'ut 004321' }))).toMatchObject({ outcome: 'applied', orderRef: o.orderRef });
  });

  it('a cancelled order owes nothing, so a late payment goes to suspense', async () => {
    const o = await order(60_000);
    await cancelOrder(env.ctx, { orderRef: o.orderRef, reason: 'x', actor: 'a' });
    expect(await pay({ amountCents: 60_000, accountRef: o.orderRef })).toMatchObject({ outcome: 'excess', appliedCents: 0, suspenseCents: 60_000 });
  });

  it('an order with a payment cannot simply be cancelled', async () => {
    const o = await order(60_000);
    await pay({ amountCents: 10_000, accountRef: o.orderRef });
    await expect(cancelOrder(env.ctx, { orderRef: o.orderRef, reason: 'x', actor: 'a' })).rejects.toMatchObject({ code: 'ORDER_HAS_PAYMENTS' });
  });

  it('rule 5, duplicate: the same transaction code is recorded once, however many times it arrives', async () => {
    const o = await order(90_000);
    const first = await pay({ transCode: 'DUP0000001', amountCents: 90_000, accountRef: o.orderRef });
    const second = await pay({ transCode: 'dup0000001', amountCents: 90_000, accountRef: o.orderRef }); // re-sent, different case
    const third = await pay({ transCode: 'DUP0000001', amountCents: 5, accountRef: undefined });       // even with different details
    expect(first.duplicate).toBe(false);
    expect([second.duplicate, third.duplicate]).toEqual([true, true]);
    expect(second.paymentId).toBe(first.paymentId);
    expect(third).toMatchObject({ outcome: 'applied', appliedCents: 90_000 }); // always the FIRST result
    expect((await env.db.pool.query(`SELECT count(*)::int AS n FROM paybill_payments WHERE trans_code = 'DUP0000001'`)).rows[0].n).toBe(1);
    expect((await env.db.pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key = 'paybill:DUP0000001'`)).rows[0].n).toBe(1);
    expect((await getOrderTx(env.db.pool, o.orderRef))!.paidCents).toBe(90_000);
  });

  it('rule 5 under pressure: six copies of one notice arriving at once post exactly once', async () => {
    const o = await order(55_000);
    const results = await Promise.all(Array.from({ length: 6 }, () => pay({ transCode: 'RACE000001', amountCents: 55_000, accountRef: o.orderRef })));
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.paymentId)).size).toBe(1);
    expect((await getOrderTx(env.db.pool, o.orderRef))!.paidCents).toBe(55_000);
  });

  it('two DIFFERENT payments racing for one order never push it past what it owes', async () => {
    const o = await order(100_000);
    const results = await Promise.all(Array.from({ length: 5 }, () => pay({ amountCents: 60_000, accountRef: o.orderRef })));
    const applied = results.reduce((s, r) => s + r.appliedCents, 0);
    const suspense = results.reduce((s, r) => s + r.suspenseCents, 0);
    expect(applied).toBe(100_000);              // exactly what was owed, no more
    expect(suspense).toBe(5 * 60_000 - 100_000); // everything else is parked
    const view = (await getOrderTx(env.db.pool, o.orderRef))!;
    expect([view.balanceCents, view.paidCents]).toEqual([0, 100_000]);
  });

  it('rejects malformed notices', async () => {
    await expect(pay({ transCode: 'bad', amountCents: 100 })).rejects.toMatchObject({ code: 'PAYMENT_BAD_CODE' });
    await expect(pay({ amountCents: 0 })).rejects.toMatchObject({ code: 'PAYMENT_BAD_AMOUNT' });
    await expect(pay({ amountCents: -5 })).rejects.toMatchObject({ code: 'PAYMENT_BAD_AMOUNT' });
    await expect(pay({ amountCents: 1.5 })).rejects.toMatchObject({ code: 'PAYMENT_BAD_AMOUNT' });
  });

  it('payment records cannot be edited or deleted', async () => {
    await pay({ amountCents: 1_000 });
    await expect(env.db.pool.query(`UPDATE paybill_payments SET amount_cents = amount_cents + 1`)).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`DELETE FROM paybill_payments`)).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`DELETE FROM payment_exceptions`)).rejects.toThrow(/immutable/);
  });
});

describe('rule 6: cash at the shop is an exception', () => {
  it('needs a reason, is receipted as cash, and lands in staff cash in hand', async () => {
    const o = await order(45_000);
    await expect(recordShopCash({ pool: env.db.pool }, { orderRef: o.orderRef, amountCents: 45_000, reason: ' ', actor: 'cashier' })).rejects.toMatchObject({ code: 'CASH_REASON_REQUIRED' });
    const before = await accountBalance(env.db.pool, 'STAFF_CASH_IN_HAND');
    const r = await recordShopCash({ pool: env.db.pool }, { orderRef: o.orderRef, amountCents: 45_000, reason: 'Customer collected in person, no phone', actor: 'cashier' });
    expect(r.balanceCents).toBe(0);
    expect(await accountBalance(env.db.pool, 'STAFF_CASH_IN_HAND')).toBe(before + 45_000);
    const view = (await getOrderTx(env.db.pool, o.orderRef))!;
    expect(view.paymentStatus).toBe('paid');
    expect((await env.db.pool.query(`SELECT method FROM payment_receipts WHERE receipt_no = $1`, [r.receiptNo])).rows[0].method).toBe('cash');
    expect(view.events.map((e) => e.type)).toContain('shop_cash_recorded');
  });

  it('cannot exceed what is owed (cash cannot be parked in suspense)', async () => {
    const o = await order(45_000);
    await expect(recordShopCash({ pool: env.db.pool }, { orderRef: o.orderRef, amountCents: 45_001, reason: 'x', actor: 'c' })).rejects.toMatchObject({ code: 'CASH_EXCEEDS_BALANCE' });
    await expect(recordShopCash({ pool: env.db.pool }, { orderRef: 'UT-22222222', amountCents: 1, reason: 'x', actor: 'c' })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });
});

describe('working through suspense', () => {
  it('suggests orders by phone number and by exact amount, never auto-applying', async () => {
    const phone = '0733 444 555';
    const mine = await order(33_000, { customerPhone: phone });
    const sameAmount = await order(77_000);
    await order(11_111);
    const stray = await pay({ amountCents: 77_000, accountRef: 'oops', msisdn: '+254733444555' });
    const exc = (await listSuspense(env.db.pool)).find((s) => s.transCode === stray.transCode)!;
    const suggestions = await suggestMatches(env.db.pool, exc.exceptionId);
    expect(suggestions.find((s) => s.orderRef === mine.orderRef)?.reasons).toEqual(['same_phone']);
    expect(suggestions.find((s) => s.orderRef === sameAmount.orderRef)?.reasons).toEqual(['exact_amount']);
    expect((await listSuspense(env.db.pool)).find((s) => s.transCode === stray.transCode)?.remainingCents).toBe(77_000); // untouched
  });

  it('a person applies it to an order: ledger, receipt and order all follow, and it leaves the suspense list', async () => {
    const o = await order(66_000);
    const stray = await pay({ amountCents: 66_000, accountRef: 'wrong' });
    const exc = (await listSuspense(env.db.pool)).find((s) => s.transCode === stray.transCode)!;
    const r = await applySuspenseToOrder({ pool: env.db.pool }, { exceptionId: exc.exceptionId, orderRef: o.orderRef, actor: 'manager' });
    expect(r).toMatchObject({ appliedCents: 66_000, remainingCents: 0 });
    expect((await getOrderTx(env.db.pool, o.orderRef))!.paymentStatus).toBe('paid');
    expect((await listSuspense(env.db.pool)).some((s) => s.transCode === stray.transCode)).toBe(false);
    await expect(applySuspenseToOrder({ pool: env.db.pool }, { exceptionId: exc.exceptionId, orderRef: o.orderRef, actor: 'm' })).rejects.toMatchObject({ code: 'EXCEPTION_ALREADY_RESOLVED' });
  });

  it('applies only what the order owes; the rest stays in suspense and can go to another order', async () => {
    const small = await order(20_000);
    const other = await order(50_000);
    const stray = await pay({ amountCents: 70_000, accountRef: 'nope' });
    const exc = (await listSuspense(env.db.pool)).find((s) => s.transCode === stray.transCode)!;
    expect(await applySuspenseToOrder({ pool: env.db.pool }, { exceptionId: exc.exceptionId, orderRef: small.orderRef, actor: 'm' })).toMatchObject({ appliedCents: 20_000, remainingCents: 50_000 });
    expect((await listSuspense(env.db.pool)).find((s) => s.transCode === stray.transCode)?.remainingCents).toBe(50_000);
    expect(await applySuspenseToOrder({ pool: env.db.pool }, { exceptionId: exc.exceptionId, orderRef: other.orderRef, actor: 'm' })).toMatchObject({ appliedCents: 50_000, remainingCents: 0 });
    await expect(applySuspenseToOrder({ pool: env.db.pool }, { exceptionId: exc.exceptionId, orderRef: small.orderRef, actor: 'm' })).rejects.toMatchObject({ code: 'EXCEPTION_ALREADY_RESOLVED' });
  });

  it('refuses to apply to an order that owes nothing, or to one that does not exist', async () => {
    const paid = await order(10_000);
    await pay({ amountCents: 10_000, accountRef: paid.orderRef });
    const stray = await pay({ amountCents: 5_000, accountRef: 'nope' });
    const exc = (await listSuspense(env.db.pool)).find((s) => s.transCode === stray.transCode)!;
    await expect(applySuspenseToOrder({ pool: env.db.pool }, { exceptionId: exc.exceptionId, orderRef: paid.orderRef, actor: 'm' })).rejects.toMatchObject({ code: 'ORDER_NOTHING_DUE' });
    await expect(applySuspenseToOrder({ pool: env.db.pool }, { exceptionId: exc.exceptionId, orderRef: 'UT-22222222', actor: 'm' })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
    await expect(applySuspenseToOrder({ pool: env.db.pool }, { exceptionId: 999_999, orderRef: paid.orderRef, actor: 'm' })).rejects.toMatchObject({ code: 'EXCEPTION_NOT_FOUND' });
  });

  it('two people applying the same suspense money at once cannot apply it twice', async () => {
    const a = await order(50_000);
    const b = await order(50_000);
    const stray = await pay({ amountCents: 50_000, accountRef: 'nope' });
    const exc = (await listSuspense(env.db.pool)).find((s) => s.transCode === stray.transCode)!;
    const results = await Promise.allSettled([
      applySuspenseToOrder({ pool: env.db.pool }, { exceptionId: exc.exceptionId, orderRef: a.orderRef, actor: 'm1' }),
      applySuspenseToOrder({ pool: env.db.pool }, { exceptionId: exc.exceptionId, orderRef: b.orderRef, actor: 'm2' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const applied = (await env.db.pool.query(`SELECT COALESCE(sum(amount_cents), 0)::bigint AS s FROM exception_resolutions WHERE exception_id = $1`, [exc.exceptionId])).rows[0].s;
    expect(applied).toBe(50_000);
  });

  it('a refund needs a reason, cannot exceed what remains, and closes the item', async () => {
    const stray = await pay({ amountCents: 20_000, accountRef: 'nope' });
    const exc = (await listSuspense(env.db.pool)).find((s) => s.transCode === stray.transCode)!;
    const clearingBefore = await accountBalance(env.db.pool, 'PAYBILL_CLEARING');
    await expect(refundSuspense({ pool: env.db.pool }, { exceptionId: exc.exceptionId, reason: '  ', actor: 'm' })).rejects.toMatchObject({ code: 'REFUND_REASON_REQUIRED' });
    await expect(refundSuspense({ pool: env.db.pool }, { exceptionId: exc.exceptionId, amountCents: 20_001, reason: 'x', actor: 'm' })).rejects.toMatchObject({ code: 'REFUND_TOO_LARGE' });
    expect(await refundSuspense({ pool: env.db.pool }, { exceptionId: exc.exceptionId, reason: 'Paid the wrong paybill, returned by M-Pesa reversal', actor: 'manager' })).toEqual({ refundedCents: 20_000, remainingCents: 0 });
    expect(await accountBalance(env.db.pool, 'PAYBILL_CLEARING')).toBe(clearingBefore - 20_000);
    expect((await listSuspense(env.db.pool)).some((s) => s.transCode === stray.transCode)).toBe(false);
  });
});

describe('the books stay right under a mixed workload', () => {
  it('after 60 random payments, duplicates, typos and resolutions: the ledger balances, no order is overpaid, suspense reconciles', async () => {
    const orders = await Promise.all([30_000, 45_000, 80_000].map((c) => order(c)));
    let seed = 12345;
    const rnd = (max: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % max; };
    const sent: { transCode: string; amountCents: number; accountRef?: string }[] = [];
    for (let i = 0; i < 60; i++) {
      const target = orders[rnd(3)]!;
      const notice = { transCode: code(), amountCents: 1_000 + rnd(60_000), accountRef: rnd(5) === 0 ? 'typo' : target.orderRef };
      sent.push(notice);
      await ingestPaybillPayment({ pool: env.db.pool }, notice);
      if (rnd(4) === 0) await ingestPaybillPayment({ pool: env.db.pool }, notice); // a re-send
    }
    for (const s of (await listSuspense(env.db.pool)).slice(0, 5)) {
      await refundSuspense({ pool: env.db.pool }, { exceptionId: s.exceptionId, amountCents: Math.min(1_000, s.remainingCents), reason: 'test refund', actor: 'm' });
    }
    for (const o of orders) {
      const v = (await getOrderTx(env.db.pool, o.orderRef))!;
      expect(v.balanceCents).toBeGreaterThanOrEqual(0);
      expect(v.balanceCents).toBeLessThanOrEqual(v.totalCents);
      expect(v.paidCents + v.balanceCents).toBe(v.totalCents);
    }
    expect((await trialBalance(env.db.pool)).totalCents).toBe(0);
    const report = await runIntegrityChecks(env.db.pool);
    expect(report.violations).toEqual([]);
    const seen = (await env.db.pool.query(`SELECT count(*)::int AS n FROM paybill_payments`)).rows[0].n;
    expect(seen).toBeGreaterThanOrEqual(60);
  });
});
