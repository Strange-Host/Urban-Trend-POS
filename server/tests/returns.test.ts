import { afterAll, describe, expect, it } from 'vitest';
import { raiseAlert, acknowledgeAlert, listAlerts } from '../src/alerts/alerts.js';
import { createProduct } from '../src/catalog/products.js';
import { getCustomer } from '../src/customers/customers.js';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { runNightlyIntegrity } from '../src/integrity/job.js';
import { accountBalance } from '../src/ledger/ledger.js';
import { createLogger } from '../src/logger.js';
import { moneyAtRisk } from '../src/orders/atRisk.js';
import { getOrderTx, recordDeliveryAttempt } from '../src/orders/orders.js';
import { ingestPaybillPayment } from '../src/orders/payments.js';
import { receiveReturnedOrder } from '../src/orders/returns.js';
import { getProduct } from '../src/catalog/products.js';
import { receiveStock } from '../src/stock/stock.js';
import { dispatch, makeEnv, newOrder, type Env } from './orderHelpers.js';

const envs: Env[] = [];
afterAll(async () => { for (const e of envs) await e.db.drop(); });
const fresh = async () => { const e = await makeEnv(); envs.push(e); return e; };
const A = { actor: 'mona', role: 'manager' };
let n = 0;

async function returningOrder(env: Env, over: { qty?: number; stock?: number; paid?: number } = {}) {
  const p = await createProduct(env.db.pool, { sku: `RET-${++n}`, name: `Shoe ${n}`, priceCents: 100_000, ...A });
  await receiveStock(env.db.pool, { productId: p.id, quantity: over.stock ?? 5, ...A });
  const o = await newOrder(env, { items: [{ sku: p.sku, name: p.name, quantity: over.qty ?? 2, unitPriceCents: 100_000 }] });
  if (over.paid) await ingestPaybillPayment({ pool: env.db.pool }, { transCode: `RETPAY${String(++n).padStart(5, '0')}`, amountCents: over.paid, accountRef: o.orderRef });
  await dispatch(env, o.orderRef);
  await recordDeliveryAttempt(env.ctx, { orderRef: o.orderRef, outcome: 'refused', reason: 'Customer refused at the door', actor: 'mona' });
  return { p, o };
}

describe('receiving a returned parcel', () => {
  it('puts restocked goods back, leaves damaged ones out, takes the unpaid balance off sales and closes the order', async () => {
    const env = await fresh();
    const { p, o } = await returningOrder(env, { qty: 2 });
    expect(await getProduct(env.db.pool, p.id)).toMatchObject({ onHand: 3 }); // 5 - 2 dispatched
    expect((await moneyAtRisk(env.db.pool, { returningDays: 0 })).some((r) => r.kind === 'returning' && r.orderRef === o.orderRef)).toBe(true);

    const r = await receiveReturnedOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: [{ orderItemId: (await getOrderTx(env.db.pool, o.orderRef))!.items.length ? await firstItemId(env, o.orderRef) : 0, restockQuantity: 1, damagedQuantity: 1 }], ...A });
    expect(r.order.status).toBe('returned');
    expect(r.unpaidWrittenOffCents).toBe(200_000);
    expect(r.customerCreditCents).toBe(0);
    expect(await getProduct(env.db.pool, p.id)).toMatchObject({ onHand: 4 }); // one went back, one was damaged
    expect(await accountBalance(env.db.pool, 'CUSTOMER_RECEIVABLE', { orderRef: o.orderRef })).toBe(0);
    expect(await accountBalance(env.db.pool, 'SALES', { orderRef: o.orderRef })).toBe(0);
    expect((await moneyAtRisk(env.db.pool, { returningDays: 0 })).some((x) => x.kind === 'returning' && x.orderRef === o.orderRef)).toBe(false);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
    expect((await getCustomer(env.db.pool, (await env.db.pool.query(`SELECT customer_id FROM orders WHERE order_ref = $1`, [o.orderRef])).rows[0].customer_id))!.stats).toMatchObject({ returned: 1, delivered: 0 });
  });

  it('is done once, only for a returning order, and counts nothing it cannot have received', async () => {
    const env = await fresh();
    const { o } = await returningOrder(env, { qty: 2 });
    const id = await firstItemId(env, o.orderRef);
    await expect(receiveReturnedOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: [{ orderItemId: id, restockQuantity: 3 }], ...A })).rejects.toMatchObject({ code: 'RETURN_EXCEEDS_SENT' });
    await expect(receiveReturnedOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: [{ orderItemId: 999999, restockQuantity: 1 }], ...A })).rejects.toMatchObject({ code: 'ORDER_ITEM_NOT_FOUND' });
    await expect(receiveReturnedOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: [{ orderItemId: id, restockQuantity: 1 }], ...A })).rejects.toMatchObject({ code: 'RETURN_MISSING_NEEDS_NOTE' });
    const ok = await receiveReturnedOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: [{ orderItemId: id, restockQuantity: 1 }], notes: 'One pair not in the parcel when it came back', ...A });
    expect(ok.order.status).toBe('returned');
    await expect(receiveReturnedOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: [{ orderItemId: id, restockQuantity: 2 }], ...A })).rejects.toMatchObject({ code: 'ORDER_WRONG_STATE' });
    const audit = await env.db.pool.query(`SELECT risk FROM audit_log WHERE action = 'order_return_received'`);
    expect(audit.rows[0].risk).toBe(2); // goods went missing
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('refuses an order that is not returning', async () => {
    const env = await fresh();
    const o = await newOrder(env);
    await expect(receiveReturnedOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: [{ orderItemId: 1, restockQuantity: 1 }], ...A })).rejects.toMatchObject({ code: 'ORDER_WRONG_STATE' });
  });

  it('writes off only what was unpaid and reports the customer\'s own money as credit', async () => {
    const env = await fresh();
    const { o } = await returningOrder(env, { qty: 2, paid: 50_000 });
    const r = await receiveReturnedOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: [{ orderItemId: await firstItemId(env, o.orderRef), restockQuantity: 2 }], ...A });
    expect(r.unpaidWrittenOffCents).toBe(150_000);
    expect(await accountBalance(env.db.pool, 'CUSTOMER_RECEIVABLE', { orderRef: o.orderRef })).toBe(0);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('is noticed by the nightly check when a returned order has lost its return record', async () => {
    const env = await fresh();
    const { o } = await returningOrder(env, { qty: 1 });
    await receiveReturnedOrder({ pool: env.db.pool }, { orderRef: o.orderRef, items: [{ orderItemId: await firstItemId(env, o.orderRef), restockQuantity: 1 }], ...A });
    const c = await env.db.pool.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query(`DELETE FROM stock_movements WHERE type = 'return_restock'`);
      await c.query(`DELETE FROM order_returns`);
    } finally { await c.query('RESET session_replication_role'); c.release(); }
    const checks = (await runIntegrityChecks(env.db.pool)).violations.map((v) => v.check);
    expect(checks).toContain('returned_without_record');
  });
});

async function firstItemId(env: Env, ref: string): Promise<number> {
  return (await env.db.pool.query(`SELECT i.id FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.order_ref = $1 ORDER BY i.id LIMIT 1`, [ref])).rows[0].id;
}

describe('alerts', () => {
  it('raises one open alert per kind, and an acknowledged one frees the slot', async () => {
    const env = await fresh();
    const a = await raiseAlert(env.db.pool, { kind: 'integrity_failed', title: 'Check failed' });
    expect(a).not.toBeNull();
    expect(await raiseAlert(env.db.pool, { kind: 'integrity_failed', title: 'Again' })).toBeNull();
    expect((await listAlerts(env.db.pool, { openOnly: true, limit: 10, offset: 0 })).openCount).toBe(1);
    const acked = await acknowledgeAlert(env.db.pool, { id: a!.id, note: 'Looked into it', actor: 'mona' });
    expect(acked.acknowledgedBy).toBe('mona');
    await expect(acknowledgeAlert(env.db.pool, { id: a!.id, actor: 'mona' })).rejects.toMatchObject({ code: 'ALERT_ALREADY_ACKNOWLEDGED' });
    await expect(env.db.pool.query(`UPDATE alerts SET title = 'edited' WHERE id = $1`, [a!.id])).rejects.toThrow(/only be acknowledged/);
    expect(await raiseAlert(env.db.pool, { kind: 'integrity_failed', title: 'Next night' })).not.toBeNull();
  });

  it('is raised by the nightly job when the check fails, once, and not when it passes', async () => {
    const env = await fresh();
    const logger = createLogger('silent');
    await runNightlyIntegrity(env.db.pool, { logger, force: true });
    expect((await listAlerts(env.db.pool, { openOnly: true, limit: 10, offset: 0 })).openCount).toBe(0);
    await env.db.pool.query(`ALTER TABLE stock_movements DISABLE TRIGGER stock_movements_not_negative`); // something a check will notice
    const r = await runNightlyIntegrity(env.db.pool, { logger, force: true });
    expect(r.ran && r.report.ok).toBe(false);
    await runNightlyIntegrity(env.db.pool, { logger, force: true });
    const open = await listAlerts(env.db.pool, { openOnly: true, limit: 10, offset: 0 });
    expect(open.openCount).toBe(1);
    expect(open.alerts[0]).toMatchObject({ kind: 'integrity_failed', severity: 'high' });
    expect(open.alerts[0]!.body.violationCount).toBeGreaterThanOrEqual(1);
  });
});
