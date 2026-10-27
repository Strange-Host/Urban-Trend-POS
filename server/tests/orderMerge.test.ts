import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createProduct, getProduct } from '../src/catalog/products.js';
import { runMigrations } from '../src/db/migrate.js';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { accountBalance, trialBalance } from '../src/ledger/ledger.js';
import { createLogger } from '../src/logger.js';
import { addItemsToOrder } from '../src/orders/merge.js';
import { cancelOrder } from '../src/orders/orders.js';
import { ingestPaybillPayment } from '../src/orders/payments.js';
import { receiveStock } from '../src/stock/stock.js';
import { loggedIn } from './authHelpers.js';
import { makeTestDb, type TestDb } from './helpers.js';
import { dispatch, KEY, makeEnv, newOrder, type Env } from './orderHelpers.js';

let env: Env;
let app: ReturnType<typeof createApp>;
beforeAll(async () => { env = await makeEnv(); app = createApp({ pool: env.db.pool, logger: createLogger('silent'), orderRefKey: KEY }); });
afterAll(() => env.db.drop());
const A = { actor: 'mona', role: 'manager' };
const more = [{ name: 'Socks', quantity: 2, unitPriceCents: 40_000 }];

describe('adding items to an order that has not left the shop', () => {
  it('keeps the reference, grows the amounts, books the added value separately and logs an event', async () => {
    const o = await newOrder(env, { items: [{ name: 'Sneakers', quantity: 1, unitPriceCents: 500_000 }] });
    const m = await addItemsToOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: more, actor: 'mona' });
    expect(m.orderRef).toBe(o.orderRef);
    expect(m.subtotalCents).toBe(580_000);
    expect(m.totalCents).toBe(580_000);
    expect(m.balanceCents).toBe(580_000);
    expect(m.items.map((i) => i.name)).toEqual(['Sneakers', 'Socks']);
    expect(await accountBalance(env.db.pool, 'SALES', { orderRef: o.orderRef })).toBe(-580_000);
    const ev = m.events.find((e) => e.type === 'items_added')!;
    expect(ev.data).toMatchObject({ added_cents: 80_000, items: 1 });
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
    expect((await trialBalance(env.db.pool)).totalCents).toBe(0);
  });

  it('can be done more than once, and with money already paid on the order', async () => {
    const o = await newOrder(env);
    await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'MRG0000001', amountCents: 200_000, payerName: 'W', accountRef: o.orderRef });
    await addItemsToOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: more, actor: 'mona' });
    const m = await addItemsToOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: more, actor: 'mona' });
    expect(m.totalCents).toBe(500_000 + 160_000);
    expect(m.paidCents).toBe(200_000);
    expect(m.balanceCents).toBe(460_000);
    expect(m.paymentStatus).toBe('part_paid');
    expect(m.events.filter((e) => e.type === 'items_added')).toHaveLength(2);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('is refused once the order has left the shop, or was cancelled', async () => {
    const sent = await newOrder(env);
    await dispatch(env, sent.orderRef);
    await expect(addItemsToOrder({ pool: env.db.pool }, { orderRef: sent.orderRef, items: more, actor: 'mona' })).rejects.toMatchObject({ code: 'ORDER_WRONG_STATE' });
    const gone = await newOrder(env);
    await cancelOrder(env.ctx, { orderRef: gone.orderRef, reason: 'changed mind', actor: 'mona' });
    await expect(addItemsToOrder({ pool: env.db.pool }, { orderRef: gone.orderRef, items: more, actor: 'mona' })).rejects.toMatchObject({ code: 'ORDER_WRONG_STATE' });
    await expect(addItemsToOrder({ pool: env.db.pool }, { orderRef: 'UT-22222222', items: more, actor: 'mona' })).rejects.toMatchObject({ code: 'ORDER_NOT_FOUND' });
  });

  it('validates what is added and leaves the order untouched when it fails', async () => {
    const o = await newOrder(env);
    const add = (items: unknown[], actor = 'mona') => addItemsToOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: items as never, actor });
    await expect(add([])).rejects.toMatchObject({ code: 'ORDER_NO_ITEMS' });
    await expect(add(more, ' ')).rejects.toMatchObject({ code: 'ORDER_NO_ACTOR' });
    await expect(add([{ name: 'X', quantity: 0, unitPriceCents: 100 }])).rejects.toMatchObject({ code: 'ORDER_BAD_AMOUNT' });
    await expect(add([{ name: 'X', quantity: 1, unitPriceCents: 100, discountCents: 101 }])).rejects.toMatchObject({ code: 'DISCOUNT_EXCEEDS_LINE' });
    await expect(add([{ name: 'X', quantity: 1, unitPriceCents: 100, discountCents: 100 }])).rejects.toMatchObject({ code: 'ORDER_TOTAL_NOT_POSITIVE' });
    const after = (await env.db.pool.query(`SELECT total_cents::int AS t, (SELECT count(*)::int FROM order_items WHERE order_id = o.id) AS n FROM orders o WHERE order_ref = $1`, [o.orderRef])).rows[0];
    expect(after).toEqual({ t: 500_000, n: 1 });
  });

  it('checks stock for the new items, counting what this order already holds', async () => {
    const p = await createProduct(env.db.pool, { sku: 'MRG-1', name: 'Merge item', priceCents: 10_000, ...A });
    await receiveStock(env.db.pool, { productId: p.id, quantity: 5, ...A });
    const o = await newOrder(env, { items: [{ sku: p.sku, name: p.name, quantity: 3, unitPriceCents: 10_000 }] });
    await expect(addItemsToOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: [{ sku: p.sku, name: p.name, quantity: 3, unitPriceCents: 10_000 }], actor: 'mona' })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    await addItemsToOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: [{ sku: p.sku, name: p.name, quantity: 2, unitPriceCents: 10_000 }], actor: 'mona' });
    expect(await getProduct(env.db.pool, p.id)).toMatchObject({ onHand: 5, reserved: 5, available: 0 });
  });

  it('cancelling afterwards takes everything off the ledger, including what was added', async () => {
    const o = await newOrder(env);
    await addItemsToOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: more, actor: 'mona' });
    await cancelOrder(env.ctx, { orderRef: o.orderRef, reason: 'customer withdrew', actor: 'mona' });
    expect(await accountBalance(env.db.pool, 'CUSTOMER_RECEIVABLE', { orderRef: o.orderRef })).toBe(0);
    expect(await accountBalance(env.db.pool, 'SALES', { orderRef: o.orderRef })).toBe(0);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });
});

describe('the database still protects the amounts', () => {
  it('refuses to lower a total, to change it while the subtotal stays, or to grow it after dispatch', async () => {
    const o = await newOrder(env);
    const q = (sql: string) => env.db.pool.query(sql, [o.id]);
    await expect(q(`UPDATE orders SET total_cents = 1, subtotal_cents = 1 WHERE id = $1`)).rejects.toThrow(/never change/);
    await expect(q(`UPDATE orders SET total_cents = total_cents + 5 WHERE id = $1`)).rejects.toThrow(/never change/);
    await expect(q(`UPDATE orders SET subtotal_cents = subtotal_cents + 5, total_cents = total_cents + 6 WHERE id = $1`)).rejects.toThrow(/never change/);
    await expect(q(`UPDATE orders SET customer_name = 'Someone Else' WHERE id = $1`)).rejects.toThrow(/never change/);
    await dispatch(env, o.orderRef);
    await expect(q(`UPDATE orders SET subtotal_cents = subtotal_cents + 5, total_cents = total_cents + 5 WHERE id = $1`)).rejects.toThrow(/never change/);
  });

  it('the nightly check notices lines that no longer add up to the subtotal', async () => {
    const o = await newOrder(env);
    await env.db.pool.query(`ALTER TABLE order_items DISABLE TRIGGER order_items_immutable`);
    await env.db.pool.query(`INSERT INTO order_items (order_id, name, quantity, unit_price_cents, line_total_cents) VALUES ($1, 'Sneaked in', 1, 100, 100)`, [o.id]);
    await env.db.pool.query(`ALTER TABLE order_items ENABLE TRIGGER order_items_immutable`);
    const v = (await runIntegrityChecks(env.db.pool)).violations.filter((x) => x.check === 'order_lines_match_subtotal');
    expect(v.map((x) => x.ref)).toEqual([o.orderRef]);
    await env.db.pool.query(`ALTER TABLE order_items DISABLE TRIGGER order_items_immutable`);
    await env.db.pool.query(`DELETE FROM order_items WHERE order_id = $1 AND name = 'Sneaked in'`, [o.id]);
    await env.db.pool.query(`ALTER TABLE order_items ENABLE TRIGGER order_items_immutable`);
  });
});

describe('POST /api/orders/:ref/items', () => {
  it('is a manager action, returns the grown order, and answers in the standard error shape', async () => {
    const agent = await loggedIn(env.db.pool, 'cashier');
    const mgr = await loggedIn(env.db.pool, 'manager');
    const o = await newOrder(env);
    const as = (u: { auth: string }, ref: string, body: unknown) => request(app).post(`/api/orders/${ref}/items`).set('Authorization', u.auth).send(body as object);
    expect((await as(agent, o.orderRef, { items: more })).status).toBe(403);
    const ok = await as(mgr, o.orderRef, { items: more });
    expect(ok.status).toBe(200);
    expect(ok.body.order.totalCents).toBe(580_000);
    expect((await as(mgr, o.orderRef, { items: [] })).status).toBe(422);
    const missing = await as(mgr, 'UT-22222222', { items: more });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('ORDER_NOT_FOUND');
  });
});
