import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountBalance, trialBalance } from '../src/ledger/ledger.js';
import { isValidRef } from '../src/ledger/orderRef.js';
import { cancelOrder, dispatchOrder, findOrder, getOrderTx, recordDeliveryAttempt } from '../src/orders/orders.js';
import { freshPhone, makeEnv, newOrder, type Env } from './orderHelpers.js';

let env: Env;
beforeAll(async () => { env = await makeEnv(); });
afterAll(() => env.db.drop());

describe('creating an order', () => {
  it('allocates a permanent reference, stores the lines and books what is owed to the ledger', async () => {
    const o = await newOrder(env, {
      items: [{ name: 'Sneakers', sku: 'SN-1', quantity: 2, unitPriceCents: 300_000, discountCents: 50_000 }, { name: 'Socks', quantity: 3, unitPriceCents: 10_000 }],
      discountCents: 20_000,
    });
    expect(isValidRef(o.orderRef)).toBe(true);
    expect(o.status).toBe('awaiting_dispatch');
    expect(o.subtotalCents).toBe(550_000 + 30_000);
    expect(o.discountCents).toBe(20_000);
    expect(o.totalCents).toBe(560_000);
    expect(o.items.map((i) => i.lineTotalCents)).toEqual([550_000, 30_000]);
    expect(o.balanceCents).toBe(560_000);                 // owed, per the ledger
    expect(o.paidCents).toBe(0);
    expect(o.paymentStatus).toBe('unpaid');
    expect(await accountBalance(env.db.pool, 'SALES', { orderRef: o.orderRef })).toBe(-560_000);
    expect(o.events.map((e) => e.type)).toEqual(['created']);
  });

  it('is found by its reference however it is typed, and by an old code kept as an alias', async () => {
    const o = await newOrder(env, { legacyRef: 'UT000777' });
    expect((await findOrder(env.db.pool, o.orderRef.toLowerCase().replace('-', ' ')))?.orderRef).toBe(o.orderRef);
    expect((await findOrder(env.db.pool, 'ut 000777'))?.orderRef).toBe(o.orderRef);
    expect(await findOrder(env.db.pool, 'UT-22222222')).toBeNull();
  });

  it('refuses a discount larger than its line, or larger than the sale', async () => {
    await expect(newOrder(env, { items: [{ name: 'X', quantity: 1, unitPriceCents: 1000, discountCents: 1001 }] })).rejects.toMatchObject({ code: 'DISCOUNT_EXCEEDS_LINE' });
    await expect(newOrder(env, { items: [{ name: 'X', quantity: 2, unitPriceCents: 1000 }], discountCents: 2001 })).rejects.toMatchObject({ code: 'DISCOUNT_EXCEEDS_SALE' });
    await expect(newOrder(env, { items: [{ name: 'X', quantity: 1, unitPriceCents: 1000, discountCents: 1000 }] })).rejects.toMatchObject({ code: 'ORDER_TOTAL_NOT_POSITIVE' });
  });

  it('the DATABASE also refuses an over-discounted order, whatever the code does', async () => {
    await expect(env.db.pool.query(
      `INSERT INTO orders (order_ref, customer_name, customer_phone, phone_normalized, subtotal_cents, discount_cents, total_cents, created_by)
       SELECT ref, 'x', '0700000001', '700000001', 1000, 1500, -500, 't' FROM order_refs LIMIT 1`)).rejects.toThrow(/check constraint/);
  });

  it('validates its inputs and leaves nothing behind when it fails', async () => {
    const refs = (await env.db.pool.query('SELECT count(*)::int AS n FROM order_refs')).rows[0].n;
    await expect(newOrder(env, { items: [] })).rejects.toMatchObject({ code: 'ORDER_NO_ITEMS' });
    await expect(newOrder(env, { customerName: ' ' })).rejects.toMatchObject({ code: 'ORDER_NO_CUSTOMER' });
    await expect(newOrder(env, { customerPhone: '12' })).rejects.toMatchObject({ code: 'ORDER_BAD_PHONE' });
    await expect(newOrder(env, { actor: '' })).rejects.toMatchObject({ code: 'ORDER_NO_ACTOR' });
    await expect(newOrder(env, { items: [{ name: 'X', quantity: 0, unitPriceCents: 100 }] })).rejects.toMatchObject({ code: 'ORDER_BAD_AMOUNT' });
    await expect(newOrder(env, { items: [{ name: 'X', quantity: 1, unitPriceCents: 10.5 }] })).rejects.toMatchObject({ code: 'ORDER_BAD_AMOUNT' });
    expect((await env.db.pool.query('SELECT count(*)::int AS n FROM order_refs')).rows[0].n).toBe(refs);
  });

  it('the whole ledger still sums to zero', async () => {
    expect((await trialBalance(env.db.pool)).totalCents).toBe(0);
  });
});

describe('one active order per phone number', () => {
  it('refuses a second active order for the same customer, however the number is written', async () => {
    const first = await newOrder(env, { customerPhone: '0722 111 222' });
    for (const same of ['+254722111222', '254722111222', '722111222', '0722-111-222']) {
      await expect(newOrder(env, { customerPhone: same })).rejects.toMatchObject({ code: 'DUPLICATE_ACTIVE_ORDER', details: { existingOrderRef: first.orderRef } });
    }
  });

  it('allows a new order once the previous one is no longer active', async () => {
    const phone = freshPhone();
    const a = await newOrder(env, { customerPhone: phone });
    await cancelOrder(env.ctx, { orderRef: a.orderRef, reason: 'changed mind', actor: 'agent-1' });
    const b = await newOrder(env, { customerPhone: phone });
    expect(b.orderRef).not.toBe(a.orderRef);
  });

  it('is safe when two people create an order for one customer at the same moment', async () => {
    const phone = freshPhone();
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => newOrder(env, { customerPhone: phone })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'DUPLICATE_ACTIVE_ORDER' });
  });
});

describe('orders are protected in the database', () => {
  it('an order\'s reference, customer, amounts and lines never change; it cannot be deleted', async () => {
    const o = await newOrder(env);
    await expect(env.db.pool.query(`UPDATE orders SET total_cents = 1, subtotal_cents = 1 WHERE id = $1`, [o.id])).rejects.toThrow(/never change/);
    await expect(env.db.pool.query(`UPDATE orders SET customer_name = 'Someone Else' WHERE id = $1`, [o.id])).rejects.toThrow(/never change/);
    await expect(env.db.pool.query(`DELETE FROM orders WHERE id = $1`, [o.id])).rejects.toThrow(/cannot be deleted/);
    await expect(env.db.pool.query(`TRUNCATE orders CASCADE`)).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`UPDATE order_items SET quantity = 99 WHERE order_id = $1`, [o.id])).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`DELETE FROM order_events WHERE order_id = $1`, [o.id])).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`UPDATE order_events SET type = 'x' WHERE order_id = $1`, [o.id])).rejects.toThrow(/immutable/);
  });

  it('a status can only move along the legal paths', async () => {
    const o = await newOrder(env);
    await expect(env.db.pool.query(`UPDATE orders SET status = 'delivered' WHERE id = $1`, [o.id])).rejects.toThrow(/cannot move from awaiting_dispatch to delivered/);
    await dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'a' });
    await expect(env.db.pool.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [o.id])).rejects.toThrow(/cannot move from dispatched to cancelled/);
    await recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'delivered', actor: 'a' });
    await expect(env.db.pool.query(`UPDATE orders SET status = 'dispatched' WHERE id = $1`, [o.id])).rejects.toThrow(/cannot move from delivered/);
  });
});

describe('dispatch and delivery attempts', () => {
  it('delivers: dispatch, then a delivered attempt', async () => {
    const o = await newOrder(env);
    const d = await dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'dispatcher', courierLabel: 'Rider Sam' });
    expect(d.status).toBe('dispatched');
    expect(d.dispatchedAt).not.toBeNull();
    const done = await recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'delivered', actor: 'rider' });
    expect(done.status).toBe('delivered');
    expect(done.deliveredAt).not.toBeNull();
    expect(done.attempts).toEqual([expect.objectContaining({ attemptNo: 1, outcome: 'delivered' })]);
    expect(done.events.map((e) => e.type)).toEqual(['created', 'dispatched', 'delivery_delivered']);
  });

  it('keeps EVERY attempt: rescheduled twice, then delivered', async () => {
    const o = await newOrder(env);
    await dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'a' });
    await recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'rescheduled', reason: 'not home', rescheduleFor: '2026-11-01', actor: 'rider' });
    const mid = await recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'rescheduled', reason: 'phone off', rescheduleFor: '2026-11-03', actor: 'rider' });
    expect(mid.status).toBe('dispatched');
    const done = await recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'delivered', actor: 'rider' });
    expect(done.attempts.map((a) => [a.attemptNo, a.outcome, a.rescheduleFor])).toEqual([[1, 'rescheduled', '2026-11-01'], [2, 'rescheduled', '2026-11-03'], [3, 'delivered', null]]);
  });

  it.each(['not_claimed', 'refused'] as const)('%s sends the order back (returning)', async (outcome) => {
    const o = await newOrder(env);
    await dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'a' });
    const r = await recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome, reason: 'customer said no', actor: 'rider' });
    expect(r.status).toBe('returning');
    expect(r.events.map((e) => e.type)).toContain('returning');
  });

  it('needs a reason unless delivered, and a date exactly when rescheduled', async () => {
    const o = await newOrder(env);
    await dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'a' });
    const ref = o.orderRef;
    await expect(recordDeliveryAttempt(env.ctx, { orderRef: ref, outcome: 'refused', actor: 'r' })).rejects.toMatchObject({ code: 'ATTEMPT_REASON_REQUIRED' });
    await expect(recordDeliveryAttempt(env.ctx, { orderRef: ref, outcome: 'rescheduled', reason: 'x', actor: 'r' })).rejects.toMatchObject({ code: 'ATTEMPT_DATE_REQUIRED' });
    await expect(recordDeliveryAttempt(env.ctx, { orderRef: ref, outcome: 'delivered', rescheduleFor: '2026-11-01', actor: 'r' })).rejects.toMatchObject({ code: 'ATTEMPT_DATE_UNEXPECTED' });
    expect((await getOrderTx(env.db.pool, ref))!.attempts).toHaveLength(0);
  });

  it('refuses actions in the wrong state', async () => {
    const o = await newOrder(env);
    await expect(recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'delivered', actor: 'r' })).rejects.toMatchObject({ code: 'ORDER_WRONG_STATE' }); // not dispatched yet
    await dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'a' });
    await expect(dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'a' })).rejects.toMatchObject({ code: 'ORDER_WRONG_STATE' });
    await recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'delivered', actor: 'r' });
    await expect(recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'delivered', actor: 'r' })).rejects.toMatchObject({ code: 'ORDER_WRONG_STATE' });
    await expect(dispatchOrder(env.ctx, { orderRef: 'UT-22222222', actor: 'a' })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });

  it('delivery attempts cannot be edited or deleted', async () => {
    const o = await newOrder(env);
    await dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'a' });
    await recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'refused', reason: 'no', actor: 'r' });
    await expect(env.db.pool.query(`UPDATE delivery_attempts SET outcome = 'delivered'`)).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`DELETE FROM delivery_attempts`)).rejects.toThrow(/immutable/);
  });
});

describe('cancelling', () => {
  it('takes the amount owed back off the ledger with a reversing entry, and keeps the reference forever', async () => {
    const o = await newOrder(env);
    const c = await cancelOrder(env.ctx, { orderRef: o.orderRef, reason: 'customer changed mind', actor: 'agent-1' });
    expect(c.status).toBe('cancelled');
    expect(c.paymentStatus).toBe('cancelled');
    expect(c.balanceCents).toBe(0);
    expect(await accountBalance(env.db.pool, 'SALES', { orderRef: o.orderRef })).toBe(0);
    const reversal = (await env.db.pool.query(`SELECT reason FROM journal_entries WHERE order_ref = $1 AND reverses_entry_id IS NOT NULL`, [o.orderRef])).rows;
    expect(reversal).toEqual([{ reason: 'Order cancelled: customer changed mind' }]);
    expect((await env.db.pool.query('SELECT 1 FROM order_refs WHERE ref = $1', [o.orderRef])).rowCount).toBe(1);
  });

  it('needs a reason, only works before dispatch, and only once', async () => {
    const o = await newOrder(env);
    await expect(cancelOrder(env.ctx, { orderRef: o.orderRef, reason: ' ', actor: 'a' })).rejects.toMatchObject({ code: 'ORDER_REASON_REQUIRED' });
    await cancelOrder(env.ctx, { orderRef: o.orderRef, reason: 'x', actor: 'a' });
    await expect(cancelOrder(env.ctx, { orderRef: o.orderRef, reason: 'x', actor: 'a' })).rejects.toMatchObject({ code: 'ORDER_WRONG_STATE' });
    await expect(dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'a' })).rejects.toMatchObject({ code: 'ORDER_WRONG_STATE' });

    const sent = await newOrder(env);
    await dispatchOrder(env.ctx, { orderRef: sent.orderRef, actor: 'a' });
    await expect(cancelOrder(env.ctx, { orderRef: sent.orderRef, reason: 'x', actor: 'a' })).rejects.toMatchObject({ code: 'ORDER_WRONG_STATE' });
  });
});
