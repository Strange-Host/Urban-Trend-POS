import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createStatement, recordOrgCollection } from '../src/couriers/organizations.js';
import { approveCourierCost, recordCourierCost } from '../src/couriers/payables.js';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { moneyAtRisk } from '../src/orders/atRisk.js';
import { recordShopCash } from '../src/orders/payments.js';
import { dispatch, makeEnv, newOrder, newOrg, newRider, type Env } from './orderHelpers.js';

const envs: Env[] = [];
afterAll(async () => { for (const e of envs) await e.db.drop(); });

// A healthy system: a rider with a fee and an approved cost, an organization with a settled statement, shop cash held.
async function healthy() {
  const env = await makeEnv();
  envs.push(env);
  const rider = await newRider(env);
  const a = await newOrder(env);
  await dispatch(env, a.orderRef, 'dispatcher', { courierId: rider.id, feeCents: 20_000 });
  const cost = await recordCourierCost({ pool: env.db.pool }, { courierId: rider.id, kind: 'fuel', amountCents: 3_000, description: 'fuel', actor: 'clerk' });
  await approveCourierCost({ pool: env.db.pool }, { costId: cost.id, actor: 'manager' });

  const org = await newOrg(env);
  const b = await newOrder(env, { items: [{ name: 'X', quantity: 1, unitPriceCents: 100_000 }] });
  await dispatch(env, b.orderRef, 'dispatcher', { courierId: org.id, feeCents: 20_000 });
  const col = await recordOrgCollection({ pool: env.db.pool }, { courierId: org.id, orderRef: b.orderRef, amountCents: 100_000, actor: 'clerk' });
  await createStatement({ pool: env.db.pool }, { courierId: org.id, periodStart: '2026-01-01', periodEnd: '2099-01-01', collectionIds: [col.id], chargeEnteredCents: 20_000, remittedCents: 50_000, actor: 'manager' }); // 30,000 short

  const c = await newOrder(env, { items: [{ name: 'X', quantity: 1, unitPriceCents: 9_000 }] });
  await recordShopCash({ pool: env.db.pool }, { orderRef: c.orderRef, amountCents: 9_000, reason: 'in person', actor: 'amina' });
  return { env, rider, org, a, b, c };
}

// Writes straight into the ledger with every guard off: what a bad script or a bypassed trigger could do.
async function bypass<T>(env: Env, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await env.db.pool.connect();
  try { await c.query('SET session_replication_role = replica'); return await fn(c); }
  finally { await c.query('RESET session_replication_role'); c.release(); }
}
const entry = (c: pg.PoolClient, courierId: number | null, orderRef: string | null, lines: [string, number][]) =>
  c.query(`INSERT INTO journal_entries (description, actor, courier_id, order_ref) VALUES ('bypass', 'script', $1, $2) RETURNING id`, [courierId, orderRef]).then(async (e) => {
    for (const [code, cents] of lines) await c.query(`INSERT INTO journal_lines (entry_id, account_id, amount_cents) SELECT $1, id, $3 FROM accounts WHERE code = $2`, [e.rows[0].id, code, cents]);
  });
const checks = async (env: Env) => (await runIntegrityChecks(env.db.pool)).violations.map((v) => `${v.rule}:${v.check}`);

describe('integrity checks for couriers', () => {
  it('pass on a healthy system, and count the couriers', async () => {
    const { env } = await healthy();
    const r = await runIntegrityChecks(env.db.pool);
    expect(r.violations).toEqual([]);
    expect(r.counts.couriers).toBe(2);
  });

  it('Rule 4: a courier payable that disagrees with what is earned and unpaid', async () => {
    const { env, rider } = await healthy();
    await bypass(env, (c) => entry(c, rider.id, null, [['COURIER_PACKAGE_FEES', 5_000], ['COURIER_PAYABLE', -5_000]])); // owed in the ledger, with no fee line behind it
    expect(await checks(env)).toContain('4:courier_payable_matches');
  });

  it('Rule 4: an entry on a courier balance that names no courier', async () => {
    const { env } = await healthy();
    await bypass(env, (c) => entry(c, null, null, [['COURIER_COSTS', 1_000], ['COURIER_PAYABLE', -1_000]]));
    expect(await checks(env)).toContain('4:courier_entry_has_courier');
  });

  it('Rule 5: an organization receivable that disagrees with collections minus settlements', async () => {
    const { env, org } = await healthy();
    await bypass(env, (c) => entry(c, org.id, null, [['BANK', 7_000], ['ORG_RECEIVABLE', -7_000]])); // remittance in the ledger with no statement
    expect(await checks(env)).toContain('5:org_receivable_matches');
  });

  it('Rule 11: a dispatched order with no package fee line', async () => {
    const { env } = await healthy();
    const o = await newOrder(env);
    await bypass(env, (c) => c.query(`UPDATE orders SET status = 'dispatched', dispatched_at = now() WHERE id = $1`, [o.id])); // guards off: no fee required
    const v = (await runIntegrityChecks(env.db.pool)).violations.find((x) => x.check === 'dispatch_has_fee');
    expect(v).toMatchObject({ rule: 11, ref: o.orderRef });
    // ...and it also shows up for a person to chase
    expect((await moneyAtRisk(env.db.pool)).find((i) => i.kind === 'dispatch_no_fee')).toMatchObject({ orderRef: o.orderRef });
  });

  it('Rule 12: fees and costs combined in one entry, or a payout line that is not exactly one item', async () => {
    const { env, rider } = await healthy();
    await bypass(env, (c) => entry(c, rider.id, null, [['COURIER_PACKAGE_FEES', 1_000], ['COURIER_COSTS', 1_000], ['COURIER_PAYABLE', -2_000]]));
    expect(await checks(env)).toContain('12:fees_costs_combined');
  });

  it('Rule 12: a fee whose ledger posting does not match its record', async () => {
    const { env } = await healthy();
    await bypass(env, (c) => c.query(`UPDATE package_fees SET amount_cents = amount_cents + 100 WHERE amount_cents > 0 AND id = (SELECT min(id) FROM package_fees WHERE amount_cents > 0)`));
    expect(await checks(env)).toContain('12:fee_entry_matches');
  });

  it('custody: cash in hand in the ledger with no custody record behind it', async () => {
    const { env } = await healthy();
    await bypass(env, (c) => entry(c, null, null, [['STAFF_CASH_IN_HAND', 2_000], ['TILL', -2_000]]));
    expect(await checks(env)).toContain('null:custody_reconciles');
  });

  it('a disabled protection on the Phase 4 tables is reported, including the dispatch-needs-a-fee rule', async () => {
    const { env } = await healthy();
    await env.db.pool.query('ALTER TABLE orders DISABLE TRIGGER orders_dispatch_needs_fee');
    await env.db.pool.query('ALTER TABLE courier_costs DISABLE TRIGGER courier_costs_guard');
    await env.db.pool.query('ALTER TABLE org_statements DISABLE TRIGGER org_statements_immutable');
    const v = (await runIntegrityChecks(env.db.pool)).violations.filter((x) => x.check === 'guard_enabled');
    expect(v.map((x) => x.rule).sort((a, b) => Number(a) - Number(b))).toEqual([7, 7, 11]);
    expect(v.map((x) => x.message).join(' ')).toMatch(/orders_dispatch_needs_fee/);
  });
});

describe('money at risk includes courier money', () => {
  it('flags courier money unpaid for a week, an overdue organization, and says who is owed', async () => {
    const { env, org } = await healthy();
    const later = new Date(Date.now() + 40 * 86_400_000);
    const items = await moneyAtRisk(env.db.pool, { now: later });
    expect(items.find((i) => i.kind === 'courier_unpaid')).toMatchObject({ amountCents: 23_000 }); // rider: 20,000 fee + 3,000 approved cost
    const overdue = items.find((i) => i.kind === 'organization_overdue');
    expect(overdue?.amountCents).toBeGreaterThan(0);
    expect(overdue?.detail).toContain(org.name);
    expect((await moneyAtRisk(env.db.pool)).some((i) => i.kind === 'courier_unpaid')).toBe(false); // fresh: not yet
  });
});
