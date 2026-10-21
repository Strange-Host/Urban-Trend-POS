import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { addDiscountReason, listDiscountReasons, setDiscountReasonActive } from '../src/pos/policy.js';
import { discountsByStaff, riskyActions } from '../src/pos/reports.js';
import { refundSale, voidSale } from '../src/pos/sales.js';
import { closeSession, recordCashMovement } from '../src/pos/sessions.js';
import { MANAGER, makeEnv, pos, sell, till, type Env } from './posHelpers.js';

const envs: Env[] = [];
afterAll(async () => { for (const e of envs) await e.db.drop(); });
const fresh = async () => { const e = await makeEnv(); envs.push(e); return e; };

// Two cashiers with different habits.
async function busyShop() {
  const e = await fresh();
  const cara = await till(e, 'cara', 500_000);
  const dan = await till(e, 'dan', 500_000);
  // cara: 3 sales, 2 discounted (one needing approval), one voided, one refunded
  const c1 = await sell(e, { cashier: 'cara', units: 1, unitPrice: 100_000, saleDiscountCents: 5_000, discountReason: 'loyalty' });            // 5% (free)
  const c2 = await sell(e, { cashier: 'cara', units: 1, unitPrice: 100_000, saleDiscountCents: 30_000, discountReason: 'price_match', approval: MANAGER }); // 30% (approved)
  const c3 = await sell(e, { cashier: 'cara', units: 1, unitPrice: 50_000 });
  await voidSale(pos(e), { saleId: c3.id, reason: 'oops', actor: 'cara', ...MANAGER });
  await refundSale(pos(e), { saleId: c1.id, items: [{ saleItemId: c1.items[0]!.id, quantity: 1 }], method: 'cash', reason: 'faulty', actor: 'cara', ...MANAGER });
  await recordCashMovement(pos(e), { sessionId: cara.id, kind: 'paid_out', amountCents: 10_000, reason: 'Delivery boy', requestedBy: 'cara', approvedBy: 'mona', approverRole: 'manager' });
  // dan: 2 plain sales, 1 small discount
  await sell(e, { cashier: 'dan', units: 2, unitPrice: 50_000 });
  await sell(e, { cashier: 'dan', units: 1, unitPrice: 100_000, saleDiscountCents: 2_000, discountReason: 'damaged_item' });
  return { e, cara, dan, c1, c2 };
}

describe('discounts by staff', () => {
  it('ranks cashiers by how much they discount, with counts, approvals and reasons; voided sales are excluded', async () => {
    const { e } = await busyShop();
    const rows = await discountsByStaff(e.db.pool);
    expect(rows.map((r) => r.cashier)).toEqual(['cara', 'dan']);   // cara discounts more of her sales
    const cara = rows[0]!;
    expect(cara).toMatchObject({ sales: 2, grossCents: 200_000, discountCents: 35_000, discountBp: 1750, discountedSales: 2, approvedSales: 1 });   // the voided 50,000 sale is not counted
    expect(cara.byReason).toEqual([{ reason: 'price_match', sales: 1, discountCents: 30_000 }, { reason: 'loyalty', sales: 1, discountCents: 5_000 }]);
    expect(rows[1]).toMatchObject({ sales: 2, grossCents: 200_000, discountCents: 2_000, discountBp: 100, discountedSales: 1, approvedSales: 0 });
  });

  it('can be limited to a date range', async () => {
    const { e } = await busyShop();
    expect(await discountsByStaff(e.db.pool, { from: new Date(Date.now() + 3_600_000) })).toEqual([]);
    expect((await discountsByStaff(e.db.pool, { to: new Date(Date.now() + 3_600_000) })).length).toBe(2);
  });

  it('reason codes can be added and deactivated, never deleted or renamed', async () => {
    const e = await fresh();
    await addDiscountReason(e.db.pool, { code: 'staff_birthday', label: 'Staff birthday', actor: 'admin' });
    await expect(addDiscountReason(e.db.pool, { code: 'staff_birthday', label: 'again', actor: 'admin' })).rejects.toMatchObject({ code: 'REASON_EXISTS' });
    await expect(addDiscountReason(e.db.pool, { code: 'Bad Code', label: 'x', actor: 'admin' })).rejects.toMatchObject({ code: 'REASON_INVALID' });
    await expect(addDiscountReason(e.db.pool, { code: 'ok_code', label: ' ', actor: 'admin' })).rejects.toMatchObject({ code: 'REASON_INVALID' });
    await expect(addDiscountReason(e.db.pool, { code: 'ok_code', label: 'x', actor: '' })).rejects.toMatchObject({ code: 'POLICY_NO_ACTOR' });
    await setDiscountReasonActive(e.db.pool, { code: 'staff_birthday', active: false, actor: 'admin' });
    expect((await listDiscountReasons(e.db.pool, { activeOnly: true })).map((r) => r.code)).not.toContain('staff_birthday');
    expect((await listDiscountReasons(e.db.pool)).map((r) => r.code)).toContain('staff_birthday');
    await expect(setDiscountReasonActive(e.db.pool, { code: 'nope', active: true, actor: 'a' })).rejects.toMatchObject({ code: 'REASON_NOT_FOUND' });
    await expect(e.db.pool.query(`DELETE FROM discount_reasons WHERE code = 'loyalty'`)).rejects.toThrow(/cannot be deleted/);
    await expect(e.db.pool.query(`UPDATE discount_reasons SET label = 'x' WHERE code = 'loyalty'`)).rejects.toThrow(/never change/);
  });
});

describe('the audit trail and the risky-actions report', () => {
  it('records every checkout, discount, void, refund and cash movement automatically, with who and how much', async () => {
    const { e } = await busyShop();
    const actions = (await e.db.pool.query(`SELECT action, count(*)::int AS n FROM audit_log GROUP BY action ORDER BY action`)).rows.map((r) => [r.action, r.n]);
    expect(Object.fromEntries(actions)).toMatchObject({ checkout: 5, discount_given: 3, void: 1, refund: 1, cash_paid_out: 1, session_opened: 2 });
    const v = (await e.db.pool.query(`SELECT actor, amount_cents, risk, details FROM audit_log WHERE action = 'void'`)).rows[0];
    expect(v).toMatchObject({ actor: 'cara', amount_cents: 50_000, risk: 2 });
    expect(v.details).toMatchObject({ reason: 'oops', approved_by: 'mona' });
  });

  it('an action and its audit row stand or fall together: a refused sale leaves no trace', async () => {
    const e = await fresh();
    await till(e, 'cara', 0);
    const before = (await e.db.pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
    await expect(sell(e, { saleDiscountCents: 90_000, discountReason: 'loyalty' })).rejects.toMatchObject({ code: 'DISCOUNT_NEEDS_APPROVAL' });
    expect((await e.db.pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(before);
    await sell(e);
    expect((await e.db.pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(before + 1);
  });

  it('the audit log cannot be edited, deleted or cleared', async () => {
    const { e } = await busyShop();
    await expect(e.db.pool.query(`UPDATE audit_log SET actor = 'someone else'`)).rejects.toThrow(/immutable/);
    await expect(e.db.pool.query(`DELETE FROM audit_log`)).rejects.toThrow(/immutable/);
    await expect(e.db.pool.query(`TRUNCATE audit_log`)).rejects.toThrow(/immutable/);
  });

  it('ranks people by risky activity: voids, refunds, approved discounts, paid-outs and till differences', async () => {
    const { e } = await busyShop();
    const rows = await riskyActions(e.db.pool);
    const c = rows.find((r) => r.actor === 'cara')!;
    expect(c).toMatchObject({
      voids: { count: 1, cents: 50_000 }, refunds: { count: 1, cents: 95_000 }, paidOuts: { count: 1, cents: 10_000 },
      discounts: { count: 2, cents: 35_000, approvedCount: 1 },
    });
    expect(c.riskScore).toBeGreaterThan(rows.find((r) => r.actor === 'dan')!.riskScore);
    expect(rows[0]!.actor).toBe('cara');                                      // the riskiest person is first
    expect(rows.every((r) => r.riskScore > 0)).toBe(true);                    // people with only routine activity are not listed
    expect(rows.find((r) => r.actor === 'dan')!.discounts).toMatchObject({ count: 1, cents: 2_000, approvedCount: 0 });
    expect(await riskyActions(e.db.pool, { from: new Date(Date.now() + 3_600_000) })).toEqual([]);
  });

  it('counts a till difference and flags the close-outs that needed a manager', async () => {
    const e = await fresh();
    const s = await till(e, 'cara', 200_000);
    await closeSession(pos(e), { sessionId: s.id, actor: 'cara', counted: { cash: 100_000, card: 0, mobile_money: 0 }, varianceReason: 'missing' });
    const c = (await riskyActions(e.db.pool)).find((r) => r.actor === 'cara')!;
    expect(c).toMatchObject({ tillVarianceCents: 100_000, sessionsNeedingSignoff: 1 });
  });
});

// Writes straight into the database with every guard off: what a bad script or a bypassed trigger could do.
async function bypass<T>(e: Env, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await e.db.pool.connect();
  try { await c.query('SET session_replication_role = replica'); return await fn(c); }
  finally { await c.query('RESET session_replication_role'); c.release(); }
}
const checks = async (e: Env) => (await runIntegrityChecks(e.db.pool)).violations.map((v) => v.check);

describe('the nightly integrity check watches the shop floor', () => {
  it('passes on a busy, healthy shop (with both tills properly closed) and counts the sales', async () => {
    const { e, cara, dan } = await busyShop();
    // cara: 500,000 float + 95,000 + 70,000 sales - 95,000 refund - 10,000 paid out = 560,000.  dan: 500,000 + 100,000 + 98,000 = 698,000.
    await closeSession(pos(e), { sessionId: cara.id, actor: 'cara', counted: { cash: 560_000, card: 0, mobile_money: 0 } });
    await closeSession(pos(e), { sessionId: dan.id, actor: 'dan', counted: { cash: 698_000, card: 0, mobile_money: 0 } });
    const r = await runIntegrityChecks(e.db.pool);
    expect(r.violations).toEqual([]);
    expect(r.counts.sales).toBe(5);
  });

  it('catches a sale that no longer matches its ledger entry', async () => {
    const { e, c2 } = await busyShop();
    await bypass(e, (c) => c.query(`UPDATE journal_lines SET amount_cents = amount_cents + 777 WHERE entry_id = (SELECT entry_id FROM sales WHERE id = $1) AND amount_cents > 0 AND id = (SELECT min(id) FROM journal_lines WHERE entry_id = (SELECT entry_id FROM sales WHERE id = $1))`, [c2.id]));
    expect(await checks(e)).toContain('sale_matches_ledger');
  });

  it('catches more refunded than was sold, or paid', async () => {
    const { e, c1 } = await busyShop();
    await bypass(e, async (c) => {
      const ref = await c.query(`SELECT id FROM sale_refunds LIMIT 1`);
      await c.query(`INSERT INTO sale_refund_items (refund_id, sale_item_id, quantity) VALUES ($1, $2, 5)`, [ref.rows[0].id, c1.items[0]!.id]);
      await c.query(`INSERT INTO sale_refunds (sale_id, session_id, method, gross_cents, discount_cents, amount_cents, reason, requested_by, approved_by, entry_id)
                     SELECT sale_id, session_id, method, 90000, 0, 90000, 'bypass', 'a', 'b', entry_id FROM sale_refunds LIMIT 1`);
    });
    const v = await checks(e);
    expect(v).toContain('refund_within_sold');
    expect(v).toContain('refund_within_paid');
    expect(v).toContain('refund_matches_ledger');
  });

  it('catches a closed till session whose figures no longer reconcile', async () => {
    const e = await fresh();
    const s = await till(e, 'cara', 100_000);
    await sell(e, { units: 1, unitPrice: 20_000 });
    await closeSession(pos(e), { sessionId: s.id, actor: 'cara', counted: { cash: 118_000, card: 0, mobile_money: 0 }, varianceReason: 'short 2,000' });
    expect(await checks(e)).toEqual([]);
    await bypass(e, (c) => c.query(`UPDATE cash_session_counts SET expected_cents = expected_cents + 5000, variance_cents = variance_cents - 5000 WHERE session_id = $1 AND method = 'cash'`, [s.id]));
    const v = await checks(e);
    expect(v).toContain('session_expected_matches');
    expect(v).toContain('session_variance_posted');
  });

  it('catches a discount above the cashier\'s limit that has no manager approval', async () => {
    const { e, c2 } = await busyShop();
    await bypass(e, (c) => c.query(`DELETE FROM discount_approvals WHERE sale_id = $1`, [c2.id]));
    expect(await checks(e)).toContain('discount_has_approval');
  });

  it('reports disabled protections on the shop-floor tables', async () => {
    const e = await fresh();
    await e.db.pool.query('ALTER TABLE sales DISABLE TRIGGER sales_guard');
    await e.db.pool.query('ALTER TABLE sales DISABLE TRIGGER sale_payments_match_total');
    await e.db.pool.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable');
    await e.db.pool.query('ALTER TABLE cash_sessions DISABLE TRIGGER cash_sessions_guard');
    const v = (await runIntegrityChecks(e.db.pool)).violations.filter((x) => x.check === 'guard_enabled');
    expect(v).toHaveLength(4);
    expect(v.map((x) => x.message).join(' ')).toMatch(/sales_guard.*|audit_log_immutable/);
  });
});
