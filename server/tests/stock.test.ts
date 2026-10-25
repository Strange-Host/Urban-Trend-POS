import { afterAll, describe, expect, it } from 'vitest';
import { createProduct, getProduct, listProducts, updateProduct } from '../src/catalog/products.js';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { cancelOrder } from '../src/orders/orders.js';
import { ingestPaybillPayment } from '../src/orders/payments.js';
import { checkout, refundSale, voidSale } from '../src/pos/sales.js';
import { adjustStock, listMovements, onHand, receiveStock, setStrict, writeOffStock } from '../src/stock/stock.js';
import { dispatch, freshPhone, makeEnv, newOrder, type Env } from './orderHelpers.js';
import { MANAGER, pos, sell, till } from './posHelpers.js';

const envs: Env[] = [];
afterAll(async () => { for (const e of envs) await e.db.drop(); });
const fresh = async () => { const e = await makeEnv(); envs.push(e); return e; };
const A = { actor: 'mona', role: 'manager' };

let n = 0;
async function product(env: Env, stock = 10, over: Partial<Parameters<typeof createProduct>[1]> = {}) {
  const p = await createProduct(env.db.pool, { sku: `SKU-${++n}`, name: `Item ${n}`, priceCents: 50_000, ...A, ...over });
  if (stock > 0) await receiveStock(env.db.pool, { productId: p.id, quantity: stock, ...A });
  return p;
}
const item = (p: { sku: string; name: string }, quantity = 1, unitPriceCents = 50_000) => ({ sku: p.sku, name: p.name, quantity, unitPriceCents });

describe('products', () => {
  it('creates, normalizes the SKU, refuses a duplicate, and shows on-hand, reserved and available', async () => {
    const env = await fresh();
    const p = await createProduct(env.db.pool, { sku: ' ab-1 ', name: 'Sneaker', priceCents: 100_000, reorderLevel: 3, ...A });
    expect(p).toMatchObject({ sku: 'AB-1', onHand: 0, reserved: 0, available: 0, lowStock: true });
    await expect(createProduct(env.db.pool, { sku: 'AB-1', name: 'Dup', priceCents: 1, ...A })).rejects.toMatchObject({ code: 'SKU_TAKEN' });
    await expect(createProduct(env.db.pool, { sku: 'bad sku!', name: 'X', priceCents: 1, ...A })).rejects.toMatchObject({ code: 'PRODUCT_BAD_SKU' });
    await expect(createProduct(env.db.pool, { sku: 'OK', name: 'X', priceCents: -5, ...A })).rejects.toMatchObject({ code: 'PRODUCT_BAD_AMOUNT' });
    await receiveStock(env.db.pool, { productId: p.id, quantity: 10, ...A });
    const o = await newOrder(env, { items: [item(p, 4)] });
    expect(await getProduct(env.db.pool, p.id)).toMatchObject({ onHand: 10, reserved: 4, available: 6, lowStock: false });
    expect(o.status).toBe('awaiting_dispatch');
  });

  it('changes price and name but never the SKU, never deletes, and locks tracking once stock has moved', async () => {
    const env = await fresh();
    const p = await product(env, 5);
    const u = await updateProduct(env.db.pool, { id: p.id, priceCents: 70_000, name: 'Renamed', ...A });
    expect(u).toMatchObject({ priceCents: 70_000, name: 'Renamed', sku: p.sku });
    await expect(env.db.pool.query(`UPDATE products SET sku = 'NEW' WHERE id = $1`, [p.id])).rejects.toThrow(/cannot be changed/);
    await expect(env.db.pool.query(`DELETE FROM products WHERE id = $1`, [p.id])).rejects.toThrow(/cannot be deleted/);
    await expect(updateProduct(env.db.pool, { id: p.id, trackStock: false, ...A })).rejects.toMatchObject({ code: 'TRACKING_LOCKED' });
    const { rows } = await env.db.pool.query(`SELECT action, risk FROM audit_log WHERE entity_id = $1 AND action LIKE 'product_%'`, [String(p.id)]);
    expect(rows.map((r) => r.action)).toContain('product_price_changed');
  });

  it('lists with search, paging and a low-stock filter', async () => {
    const env = await fresh();
    const low = await product(env, 1, { reorderLevel: 2, name: 'Zed Low' });
    await product(env, 20, { name: 'Alpha Plenty' });
    const all = await listProducts(env.db.pool, { limit: 50, offset: 0 });
    expect(all.total).toBe(2);
    expect((await listProducts(env.db.pool, { lowOnly: true, limit: 50, offset: 0 })).products.map((x) => x.id)).toEqual([low.id]);
    expect((await listProducts(env.db.pool, { search: 'plenty', limit: 50, offset: 0 })).total).toBe(1);
    expect((await listProducts(env.db.pool, { limit: 1, offset: 1 })).products).toHaveLength(1);
  });
});

describe('manual stock changes', () => {
  it('receives, adjusts and writes off, each with an audit row, and never below zero', async () => {
    const env = await fresh();
    const p = await product(env, 10);
    expect((await adjustStock(env.db.pool, { productId: p.id, delta: -3, reason: 'Stock count', ...A })).onHand).toBe(7);
    expect((await adjustStock(env.db.pool, { productId: p.id, delta: 2, reason: 'Found a box', ...A })).onHand).toBe(9);
    expect((await writeOffStock(env.db.pool, { productId: p.id, quantity: 4, reason: 'Water damage', ...A })).onHand).toBe(5);
    await expect(writeOffStock(env.db.pool, { productId: p.id, quantity: 6, reason: 'Too many', ...A })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    await expect(adjustStock(env.db.pool, { productId: p.id, delta: -6, reason: 'Too many', ...A })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    await expect(adjustStock(env.db.pool, { productId: p.id, delta: -1, reason: ' ', ...A })).rejects.toMatchObject({ code: 'STOCK_REASON_REQUIRED' });
    await expect(adjustStock(env.db.pool, { productId: p.id, delta: 0, reason: 'x', ...A })).rejects.toMatchObject({ code: 'STOCK_BAD_QUANTITY' });
    await expect(receiveStock(env.db.pool, { productId: p.id, quantity: -2, ...A })).rejects.toMatchObject({ code: 'STOCK_BAD_QUANTITY' });
    const { rows } = await env.db.pool.query(`SELECT action, risk FROM audit_log WHERE entity_type = 'product' AND entity_id = $1 AND action LIKE 'stock_%' ORDER BY id`, [String(p.id)]);
    expect(rows.map((r) => r.action)).toEqual(['stock_received', 'stock_adjusted', 'stock_adjusted', 'stock_written_off']);
    expect(rows[3]!.risk).toBe(2);
    expect((await listMovements(env.db.pool, { productId: p.id, limit: 10, offset: 0 })).total).toBe(4);
  });

  it('refuses to edit or delete a movement, or to push stock negative around the service', async () => {
    const env = await fresh();
    const p = await product(env, 3);
    await expect(env.db.pool.query(`UPDATE stock_movements SET quantity = 99 WHERE product_id = $1`, [p.id])).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`DELETE FROM stock_movements WHERE product_id = $1`, [p.id])).rejects.toThrow(/immutable/);
    await expect(env.db.pool.query(`INSERT INTO stock_movements (product_id, type, quantity, reason, actor) VALUES ($1, 'adjustment', -4, 'sneaky', 'x')`, [p.id])).rejects.toThrow(/below zero/);
    expect(await onHand(env.db.pool, p.id)).toBe(3);
  });

  it('refuses to track stock on a product that is not tracked', async () => {
    const env = await fresh();
    const svc = await createProduct(env.db.pool, { sku: 'DELIVERY', name: 'Delivery', priceCents: 10_000, trackStock: false, ...A });
    await expect(receiveStock(env.db.pool, { productId: svc.id, quantity: 1, ...A })).rejects.toMatchObject({ code: 'PRODUCT_NOT_TRACKED' });
  });
});

describe('orders reserve stock and dispatch takes it', () => {
  it('reserves on creation, refuses what is not available, takes stock out on dispatch and nothing else', async () => {
    const env = await fresh();
    const p = await product(env, 5);
    const o1 = await newOrder(env, { items: [item(p, 3)] });
    expect(await getProduct(env.db.pool, p.id)).toMatchObject({ onHand: 5, reserved: 3, available: 2 });
    const err = await newOrder(env, { items: [item(p, 3)] }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(err.details).toEqual([{ sku: p.sku, name: p.name, requested: 3, available: 2 }]);
    await newOrder(env, { items: [item(p, 2)] }); // exactly what is left is fine
    await dispatch(env, o1.orderRef);
    expect(await getProduct(env.db.pool, p.id)).toMatchObject({ onHand: 2, reserved: 2, available: 0 });
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('gives the stock back to the shelf when an awaiting order is cancelled', async () => {
    const env = await fresh();
    const p = await product(env, 2);
    const o = await newOrder(env, { items: [item(p, 2)] });
    expect((await getProduct(env.db.pool, p.id))!.available).toBe(0);
    await cancelOrder(env.ctx, { orderRef: o.orderRef, reason: 'Customer changed mind', actor: 'agent' });
    expect(await getProduct(env.db.pool, p.id)).toMatchObject({ onHand: 2, reserved: 0, available: 2 });
  });

  it('refuses to dispatch when the goods are not physically there, and a failed dispatch changes nothing', async () => {
    const env = await fresh();
    const p = await product(env, 3);
    const o = await newOrder(env, { items: [item(p, 3)] });
    await adjustStock(env.db.pool, { productId: p.id, delta: -1, reason: 'Found damaged in the box', ...A });
    await expect(dispatch(env, o.orderRef)).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    const { rows } = await env.db.pool.query(`SELECT status FROM orders WHERE order_ref = $1`, [o.orderRef]);
    expect(rows[0].status).toBe('awaiting_dispatch');
    expect(await onHand(env.db.pool, p.id)).toBe(2);
    expect((await env.db.pool.query(`SELECT 1 FROM package_fees`)).rows).toHaveLength(0);
  });

  it('sums an order\'s lines for the same product, and ignores untracked or unknown items', async () => {
    const env = await fresh();
    const p = await product(env, 4);
    const svc = await createProduct(env.db.pool, { sku: 'SVC', name: 'Gift wrap', priceCents: 5_000, trackStock: false, ...A });
    const o = await newOrder(env, { items: [item(p, 2), item(p, 2), { sku: svc.sku, name: svc.name, quantity: 9, unitPriceCents: 5_000 }, { name: 'Free text thing', quantity: 1, unitPriceCents: 1_000 }] });
    await dispatch(env, o.orderRef);
    expect(await onHand(env.db.pool, p.id)).toBe(0);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('refuses a deactivated product, and (in strict mode) an unknown or missing SKU', async () => {
    const env = await fresh();
    const p = await product(env, 5);
    await updateProduct(env.db.pool, { id: p.id, active: false, ...A });
    await expect(newOrder(env, { items: [item(p)] })).rejects.toMatchObject({ code: 'PRODUCT_INACTIVE' });
    await newOrder(env, { items: [{ sku: 'NOPE', name: 'Typed in', quantity: 1, unitPriceCents: 1_000 }] }); // allowed while not strict
    await setStrict(env.db.pool, { strict: true, ...A });
    await expect(newOrder(env, { items: [{ sku: 'NOPE', name: 'Typed in', quantity: 1, unitPriceCents: 1_000 }] })).rejects.toMatchObject({ code: 'UNKNOWN_PRODUCT' });
    await expect(newOrder(env, { items: [{ name: 'No code', quantity: 1, unitPriceCents: 1_000 }] })).rejects.toMatchObject({ code: 'ITEM_NEEDS_SKU' });
  });

  it('lets only one of two simultaneous orders take the last unit', async () => {
    const env = await fresh();
    const p = await product(env, 1);
    const results = await Promise.allSettled([newOrder(env, { items: [item(p)] }), newOrder(env, { items: [item(p)] })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });
});

describe('POS sales, voids and refunds move stock', () => {
  it('takes stock on a sale, refuses to oversell what orders are holding, and a retried sale takes it once', async () => {
    const env = await fresh();
    const p = await product(env, 5);
    await till(env, 'cara', 0);
    await newOrder(env, { items: [item(p, 3)] }); // 3 held for a customer
    await expect(sell(env, { items: [item(p, 3)] })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    const s1 = await sell(env, { items: [item(p, 2)], clientSaleId: 'client-1' });
    const again = await sell(env, { items: [item(p, 2)], clientSaleId: 'client-1' });
    expect(again.replayed).toBe(true);
    expect(again.id).toBe(s1.id);
    expect(await onHand(env.db.pool, p.id)).toBe(3);
    expect(await getProduct(env.db.pool, p.id)).toMatchObject({ onHand: 3, reserved: 3, available: 0 });
    // a replay of the same sale still works even though there is now no stock left to sell
    expect((await sell(env, { items: [item(p, 2)], clientSaleId: 'client-1' })).replayed).toBe(true);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('puts the goods back on a void', async () => {
    const env = await fresh();
    const p = await product(env, 5);
    await till(env, 'cara', 0);
    const s = await sell(env, { items: [item(p, 4)] });
    expect(await onHand(env.db.pool, p.id)).toBe(1);
    await voidSale(pos(env), { saleId: s.id, reason: 'Wrong item', actor: 'cara', ...MANAGER });
    expect(await onHand(env.db.pool, p.id)).toBe(5);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('restocks a refund by default, only for the quantity refunded, and not when told the goods are damaged', async () => {
    const env = await fresh();
    const p = await product(env, 10);
    await till(env, 'cara', 200_000);
    const s = await sell(env, { items: [item(p, 4)] });
    expect(await onHand(env.db.pool, p.id)).toBe(6);
    await refundSale(pos(env), { saleId: s.id, items: [{ saleItemId: s.items[0]!.id, quantity: 1 }], method: 'cash', reason: 'Wrong size', actor: 'cara', ...MANAGER });
    expect(await onHand(env.db.pool, p.id)).toBe(7);
    await refundSale(pos(env), { saleId: s.id, items: [{ saleItemId: s.items[0]!.id, quantity: 2 }], method: 'cash', reason: 'Torn', actor: 'cara', restock: false, ...MANAGER });
    expect(await onHand(env.db.pool, p.id)).toBe(7);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('leaves untracked and free-typed items alone', async () => {
    const env = await fresh();
    await till(env, 'cara', 0);
    const s = await sell(env);
    expect(s.status).toBe('completed');
    expect((await env.db.pool.query(`SELECT 1 FROM stock_movements`)).rows).toHaveLength(0);
  });
});

describe('nightly checks notice stock that does not add up', () => {
  it('flags a dispatch whose stock movement was removed, and a sale that took the wrong quantity', async () => {
    const env = await fresh();
    const p = await product(env, 10);
    await till(env, 'cara', 0);
    const o = await newOrder(env, { items: [item(p, 2)] });
    await dispatch(env, o.orderRef);
    await sell(env, { items: [item(p, 3)] });
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);

    const c = await env.db.pool.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query(`DELETE FROM stock_movements WHERE type = 'dispatch'`);
      await c.query(`UPDATE stock_movements SET quantity = -1 WHERE type = 'sale'`);
    } finally { await c.query('RESET session_replication_role'); c.release(); }
    const checks = (await runIntegrityChecks(env.db.pool)).violations.map((v) => v.check);
    expect(checks).toContain('dispatch_took_stock');
    expect(checks).toContain('sale_took_stock');
  });

  it('flags a disabled stock guard', async () => {
    const env = await fresh();
    await env.db.pool.query(`ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_not_negative`);
    const v = (await runIntegrityChecks(env.db.pool)).violations;
    expect(v.map((x) => x.check)).toContain('guard_enabled');
  });
});

describe('customers are made by orders and can require prepayment', () => {
  it('creates one customer per phone however it is typed, and keeps the first name', async () => {
    const env = await fresh();
    const phone = freshPhone();
    const o = await newOrder(env, { customerName: 'Wanjiku', customerPhone: phone });
    await dispatch(env, o.orderRef);
    const { rows } = await env.db.pool.query(`SELECT id FROM customers`);
    expect(rows).toHaveLength(1);
    const { rows: ord } = await env.db.pool.query(`SELECT customer_id FROM orders WHERE order_ref = $1`, [o.orderRef]);
    expect(ord[0].customer_id).toBe(rows[0].id);
  });

  it('will not dispatch to a prepay customer until the order is paid in full', async () => {
    const env = await fresh();
    const o = await newOrder(env, { customerPhone: '0722000111', items: [{ name: 'X', quantity: 1, unitPriceCents: 100_000 }] });
    const { rows } = await env.db.pool.query(`SELECT customer_id FROM orders WHERE order_ref = $1`, [o.orderRef]);
    await env.db.pool.query(`UPDATE customers SET prepay_required = true, prepay_reason = 'Refused two parcels' WHERE id = $1`, [rows[0].customer_id]);
    await expect(dispatch(env, o.orderRef)).rejects.toMatchObject({ code: 'PREPAY_REQUIRED' });
    await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'PREPAY00001', amountCents: 40_000, accountRef: o.orderRef });
    await expect(dispatch(env, o.orderRef)).rejects.toMatchObject({ code: 'PREPAY_REQUIRED' });
    await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'PREPAY00002', amountCents: 60_000, accountRef: o.orderRef });
    expect((await dispatch(env, o.orderRef)).status).toBe('dispatched');
  });
});
