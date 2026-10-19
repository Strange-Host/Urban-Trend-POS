import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { ingestPaybillPayment } from '../src/orders/payments.js';
import { dispatchOrder } from '../src/orders/orders.js';
import { makeEnv, newOrder, type Env } from './orderHelpers.js';

const envs: Env[] = [];
afterAll(async () => { for (const e of envs) await e.db.drop(); });

async function healthy(): Promise<{ env: Env; ref: string }> {
  const env = await makeEnv();
  envs.push(env);
  const o = await newOrder(env, { items: [{ name: 'X', quantity: 1, unitPriceCents: 100_000 }] });
  await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'INTEG00001', amountCents: 40_000, accountRef: o.orderRef });
  await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'INTEG00002', amountCents: 5_000, accountRef: 'unknown' });
  await dispatchOrder(env.ctx, { orderRef: o.orderRef, actor: 'a' });
  return { env, ref: o.orderRef };
}

// Posts a balanced entry straight into the ledger with the guards off: the kind of thing a bad script or a
// bypassed trigger could do, which the nightly check must notice.
async function bypassEntry(env: Env, orderRef: string | null, lines: [string, number][]) {
  const c: pg.PoolClient = await env.db.pool.connect();
  try {
    await c.query('SET session_replication_role = replica');
    const e = await c.query(`INSERT INTO journal_entries (description, actor, order_ref) VALUES ('bypass', 'script', $1) RETURNING id`, [orderRef]);
    for (const [code, cents] of lines) {
      await c.query(`INSERT INTO journal_lines (entry_id, account_id, amount_cents) SELECT $1, id, $3 FROM accounts WHERE code = $2`, [e.rows[0].id, code, cents]);
    }
  } finally { await c.query('RESET session_replication_role'); c.release(); }
}

describe('integrity checks for orders and payments', () => {
  it('pass on a healthy system and count what they saw', async () => {
    const { env } = await healthy();
    const r = await runIntegrityChecks(env.db.pool);
    expect(r.violations).toEqual([]);
    expect(r.counts).toMatchObject({ orders: 1, payments: 2 });
  });

  it('Rule 6: an order paid more than it owes', async () => {
    const { env, ref } = await healthy();
    await bypassEntry(env, ref, [['PAYBILL_CLEARING', 90_000], ['CUSTOMER_RECEIVABLE', -90_000]]); // 40k + 90k against a 100k order
    const checks = (await runIntegrityChecks(env.db.pool)).violations.map((v) => `${v.rule}:${v.check}`);
    expect(checks).toContain('6:order_within_total');
  });

  it('Rule 2: a payment in the ledger with no receipt (paid amount no longer comes from receipts)', async () => {
    const { env, ref } = await healthy();
    await bypassEntry(env, ref, [['PAYBILL_CLEARING', 10_000], ['CUSTOMER_RECEIVABLE', -10_000]]);
    const checks = (await runIntegrityChecks(env.db.pool)).violations.map((v) => `${v.rule}:${v.check}`);
    expect(checks).toContain('2:paid_matches_receipts');
    expect(checks).not.toContain('6:order_within_total'); // 50k of 100k is still within the total
  });

  it('Rule 3: customer money with no order reference', async () => {
    const { env } = await healthy();
    await bypassEntry(env, null, [['PAYBILL_CLEARING', 2_000], ['CUSTOMER_RECEIVABLE', -2_000]]);
    const checks = (await runIntegrityChecks(env.db.pool)).violations.map((v) => `${v.rule}:${v.check}`);
    expect(checks).toContain('3:money_has_reference');
  });

  it('Rule 3: suspense in the ledger that does not match the unresolved items', async () => {
    const { env } = await healthy();
    await bypassEntry(env, null, [['PAYBILL_CLEARING', 3_000], ['SUSPENSE', -3_000]]); // money parked with no suspense item to match it
    const v = (await runIntegrityChecks(env.db.pool)).violations.find((x) => x.check === 'suspense_reconciles');
    expect(v).toMatchObject({ rule: 3 });
    expect(v!.message).toContain('8000'); // 5,000 legitimately unmatched + 3,000 stray
  });

  it('a disabled protection on the new tables is reported', async () => {
    const { env } = await healthy();
    await env.db.pool.query('ALTER TABLE paybill_payments DISABLE TRIGGER paybill_payments_immutable');
    await env.db.pool.query('ALTER TABLE orders DISABLE TRIGGER orders_guard');
    const v = (await runIntegrityChecks(env.db.pool)).violations.filter((x) => x.check === 'guard_enabled').map((x) => x.message);
    expect(v).toHaveLength(2);
    expect(v.join(' ')).toMatch(/paybill_payments_immutable/);
    expect(v.join(' ')).toMatch(/orders_guard/);
  });
});
