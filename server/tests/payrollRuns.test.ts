import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clockIn, markAbsent } from '../src/payroll/attendance.js';
import { previewPayroll } from '../src/payroll/calculate.js';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { addCommissionPlan, recordAdjustment, setPayProfile } from '../src/payroll/profiles.js';
import { exportRunCsv, payslip, renderPayslip, salaryTable } from '../src/payroll/reports.js';
import { approveRun, canonicalItems, fingerprint, generateDraft, getRun, listRuns, markRunPaid, runFingerprint } from '../src/payroll/runs.js';
import { makeEnv, type Env } from './orderHelpers.js';
import { PERIOD, buildWorkedMonth, d, eat, secureByPaybill, smallPayroll } from './payrollHelpers.js';

const envs: Env[] = [];
afterAll(async () => { for (const e of envs) await e.db.drop(); });
const fresh = async () => { const e = await makeEnv(); envs.push(e); return e; };
const ctx = (env: Env) => ({ pool: env.db.pool });
const strip = <T extends { orders?: unknown }>(items: T[]) => items.map(({ orders: _o, ...rest }) => rest);

describe('PHASE 5 DONE WHEN: a locked run reproduces a test month exactly', () => {
  it('draft -> approve (lock) -> change the world -> the locked run, its payslips and its CSV are byte-for-byte the same', async () => {
    const env = await fresh();
    await buildWorkedMonth(env);
    const period = PERIOD();

    // 1. The draft is exactly the calculation, and calculating again gives the same answer.
    const draft = await generateDraft(ctx(env), { ...period, actor: 'manager' });
    expect(draft.status).toBe('draft');
    expect(JSON.stringify(draft.items)).toBe(JSON.stringify(strip(await previewPayroll(env.db.pool, period))));
    expect(draft.totals).toMatchObject({ grossCents: 324_000, deductionsCents: 139_000, netCents: 185_000, payableCents: 235_000, shortfallCents: 50_000, commissionCents: 44_000 });

    // 2. Approve: the run locks and is fingerprinted.
    const run = await approveRun(ctx(env), { runId: draft.id, actor: 'admin' });
    expect(run).toMatchObject({ status: 'approved', approvedBy: 'admin' });
    expect(run.checksum).toBe(fingerprint(canonicalItems(period, run.items)));
    expect(JSON.stringify(run.items)).toBe(JSON.stringify(draft.items)); // approval froze exactly what was reviewed

    const frozen = JSON.stringify(await getRun(env.db.pool, run.id));
    const csv = await exportRunCsv(env.db.pool, run.id);
    const slips = await Promise.all(['amina', 'brian', 'daudi', 'esther'].map(async (s) => renderPayslip(await payslip(env.db.pool, run.id, s))));

    // 3. Change EVERYTHING that feeds payroll.
    await secureByPaybill({ env, staffKey: 'brian', units: 5, unitPrice: 100_000 });   // new secure sale this period
    const newPlan = await addCommissionPlan(env.db.pool, { name: 'Richer', targetCents: 1_000_000, rateBelow70Cents: 9_000, rate70Cents: 9_000, rate80Cents: 9_000, actor: 'admin' });
    await setPayProfile(env.db.pool, { staffKey: 'amina', effectiveFrom: d(10), dailyRetainerCents: 99_000, commissionPlanId: newPlan.id, actor: 'admin' }); // takes effect inside the period
    await recordAdjustment(env.db.pool, { staffKey: 'amina', type: 'bonus', amountCents: 77_000, effectiveDate: d(40), reason: 'Next period', actor: 'admin' }); // outside the period: allowed

    // The world really did move: a fresh calculation of the same period now differs...
    expect(canonicalItems(period, await previewPayroll(env.db.pool, period))).not.toBe(canonicalItems(period, run.items));

    // 4. ...but the locked run is identical, down to the fingerprint, the CSV and every payslip.
    expect(JSON.stringify(await getRun(env.db.pool, run.id))).toBe(frozen);
    expect(await runFingerprint(env.db.pool, run.id)).toBe(run.checksum);
    expect(await exportRunCsv(env.db.pool, run.id)).toBe(csv);
    const slipsAfter = await Promise.all(['amina', 'brian', 'daudi', 'esther'].map(async (s) => renderPayslip(await payslip(env.db.pool, run.id, s))));
    expect(slipsAfter).toEqual(slips);
    const table = await salaryTable(env.db.pool, period);
    expect(table).toMatchObject({ source: 'locked', runId: run.id });
    expect(JSON.stringify(table.rows)).toBe(JSON.stringify(run.items));

    // 5. And paying it changes nothing about its figures.
    const paid = await markRunPaid(ctx(env), { runId: run.id, method: 'mpesa', paymentRef: 'SBK7654321', actor: 'admin' });
    expect(paid).toMatchObject({ status: 'paid', paidBy: 'admin', paymentMethod: 'mpesa', paymentRef: 'SBK7654321' });
    expect(JSON.stringify(paid.items)).toBe(JSON.stringify(run.items));
    expect(await runFingerprint(env.db.pool, run.id)).toBe(run.checksum);
    expect(await exportRunCsv(env.db.pool, run.id)).toBe(csv);
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  }, 120_000);
});

describe('the lifecycle', () => {
  it('regenerating a draft replaces it (same run, no duplicate people or lines)', async () => {
    const env = await fresh();
    await smallPayroll(env);
    const a = await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' });
    await recordAdjustment(env.db.pool, { staffKey: 'zed', type: 'bonus', amountCents: 1_000, effectiveDate: d(-1), reason: 'extra', actor: 'admin' });
    const b = await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' });
    expect(b.id).toBe(a.id);
    expect(b.items).toHaveLength(1);
    expect(b.items[0]!.bonusesCents).toBe(1_000);
    expect(a.items[0]!.netCents + 1_000).toBe(b.items[0]!.netCents);
    expect((await env.db.pool.query('SELECT count(*)::int AS n FROM payroll_runs')).rows[0].n).toBe(1);
    expect((await env.db.pool.query('SELECT count(*)::int AS n FROM payroll_items')).rows[0].n).toBe(1);
    expect((await listRuns(env.db.pool)).map((r) => r.status)).toEqual(['draft']);
  });

  it('computes the small test payroll exactly: 2 days retainer + low-tier commission', async () => {
    const env = await fresh();
    await smallPayroll(env);
    const run = await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' });
    expect(run.items[0]).toMatchObject({ staffKey: 'zed', daysWorked: 2, retainerCents: 20_000, unitsSold: 2, achievementBp: 2000, tier: '<70%', rateCents: 3_000, commissionCents: 6_000, netCents: 26_000, payableCents: 26_000 });
  });

  it('refuses to approve a draft that has gone stale, and approving a regenerated one works', async () => {
    const env = await fresh();
    await smallPayroll(env);
    const draft = await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' });
    await recordAdjustment(env.db.pool, { staffKey: 'zed', type: 'loss_deduction', amountCents: 2_000, effectiveDate: d(-1), reason: 'breakage', actor: 'admin' });
    await expect(approveRun(ctx(env), { runId: draft.id, actor: 'admin' })).rejects.toMatchObject({ code: 'RUN_STALE' });
    expect((await getRun(env.db.pool, draft.id))!.status).toBe('draft'); // refusal left it a draft
    await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' });
    expect((await approveRun(ctx(env), { runId: draft.id, actor: 'admin' })).items[0]!.netCents).toBe(24_000);
  });

  it('a stale draft is also refused when a NEW payment secures an order after the draft was made', async () => {
    const env = await fresh();
    await smallPayroll(env);
    const draft = await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' });
    await secureByPaybill({ env, staffKey: 'zed', units: 1, unitPrice: 100_000 });
    await expect(approveRun(ctx(env), { runId: draft.id, actor: 'admin' })).rejects.toMatchObject({ code: 'RUN_STALE' });
  });

  it('payment: only an approved run can be paid, needs a reference for M-Pesa or bank, and only once', async () => {
    const env = await fresh();
    await smallPayroll(env);
    const draft = await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' });
    await expect(markRunPaid(ctx(env), { runId: draft.id, method: 'cash', actor: 'a' })).rejects.toMatchObject({ code: 'RUN_NOT_APPROVED' });
    await approveRun(ctx(env), { runId: draft.id, actor: 'admin' });
    await expect(approveRun(ctx(env), { runId: draft.id, actor: 'admin' })).rejects.toMatchObject({ code: 'RUN_NOT_DRAFT' });
    await expect(markRunPaid(ctx(env), { runId: draft.id, method: 'mpesa', actor: 'a' })).rejects.toMatchObject({ code: 'PAYOUT_REFERENCE_REQUIRED' });
    // @ts-expect-error: not a real method
    await expect(markRunPaid(ctx(env), { runId: draft.id, method: 'barter', actor: 'a' })).rejects.toMatchObject({ code: 'PAYOUT_BAD_METHOD' });
    await expect(markRunPaid(ctx(env), { runId: draft.id, method: 'cash', actor: ' ' })).rejects.toMatchObject({ code: 'PAY_NO_ACTOR' });
    expect((await markRunPaid(ctx(env), { runId: draft.id, method: 'cash', actor: 'admin' })).status).toBe('paid');
    await expect(markRunPaid(ctx(env), { runId: draft.id, method: 'cash', actor: 'admin' })).rejects.toMatchObject({ code: 'RUN_NOT_APPROVED' });
    await expect(markRunPaid(ctx(env), { runId: 999_999, method: 'cash', actor: 'a' })).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
  });

  it('refuses to approve an empty run, a bad period, or a run that does not exist', async () => {
    const env = await fresh();
    const empty = await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' });
    expect(empty.items).toEqual([]);
    await expect(approveRun(ctx(env), { runId: empty.id, actor: 'admin' })).rejects.toMatchObject({ code: 'RUN_EMPTY' });
    await expect(generateDraft(ctx(env), { from: '2026-02-30', to: '2026-03-01', actor: 'm' })).rejects.toMatchObject({ code: 'PAYROLL_BAD_PERIOD' });
    await expect(generateDraft(ctx(env), { from: d(5), to: d(1), actor: 'm' })).rejects.toMatchObject({ code: 'PAYROLL_BAD_PERIOD' });
    await expect(generateDraft(ctx(env), { ...PERIOD(), actor: '' })).rejects.toMatchObject({ code: 'PAY_NO_ACTOR' });
    await expect(approveRun(ctx(env), { runId: 999_999, actor: 'admin' })).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    await expect(approveRun(ctx(env), { runId: empty.id, actor: '' })).rejects.toMatchObject({ code: 'PAY_NO_ACTOR' });
  });

  it('two people approving one draft at once approve it once', async () => {
    const env = await fresh();
    await smallPayroll(env);
    const draft = await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' });
    const results = await Promise.allSettled([1, 2, 3].map((i) => approveRun(ctx(env), { runId: draft.id, actor: `admin${i}` })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'RUN_NOT_DRAFT' });
    expect((await env.db.pool.query('SELECT count(*)::int AS n FROM commissioned_orders')).rows[0].n).toBe(1);
  });
});

describe('RULE 9: a locked run is locked, at every level', () => {
  async function lockedRun() {
    const env = await fresh();
    await smallPayroll(env);
    const draft = await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' });
    const run = await approveRun(ctx(env), { runId: draft.id, actor: 'admin' });
    return { env, run };
  }

  it('nothing about a locked run can be edited or deleted in the database', async () => {
    const { env, run } = await lockedRun();
    const q = (sql: string) => env.db.pool.query(sql);
    await expect(q(`UPDATE payroll_items SET net_cents = net_cents + 1, gross_cents = gross_cents + 1, payable_cents = payable_cents + 1`)).rejects.toThrow(/locked/);
    await expect(q(`DELETE FROM payroll_items`)).rejects.toThrow(/locked/);
    await expect(q(`UPDATE payroll_item_lines SET amount_cents = 1`)).rejects.toThrow(/locked/);
    await expect(q(`DELETE FROM payroll_item_lines`)).rejects.toThrow(/locked/);
    await expect(q(`INSERT INTO payroll_item_lines (item_id, kind, amount_cents) SELECT id, 'bonus', 5 FROM payroll_items`)).rejects.toThrow(/locked/);
    await expect(q(`UPDATE payroll_runs SET period_end = period_end + 1`)).rejects.toThrow(/cannot be changed|cannot change/);
    await expect(q(`DELETE FROM payroll_runs`)).rejects.toThrow(/can never be deleted/);
    await expect(q(`TRUNCATE payroll_runs CASCADE`)).rejects.toThrow(/immutable/);
    await expect(q(`UPDATE payroll_runs SET status = 'draft', checksum = NULL, approved_by = NULL, approved_at = NULL`)).rejects.toThrow(/cannot be changed/);
    await expect(q(`UPDATE payroll_runs SET checksum = 'x'`)).rejects.toThrow(/cannot be changed/);
    await expect(q(`UPDATE commissioned_orders SET units = 99`)).rejects.toThrow(/immutable/);
    await expect(q(`DELETE FROM commissioned_orders`)).rejects.toThrow(/immutable/);
    expect(await runFingerprint(env.db.pool, run.id)).toBe(run.checksum);
  });

  it('a paid run cannot go backwards or be touched either', async () => {
    const { env, run } = await lockedRun();
    await markRunPaid(ctx(env), { runId: run.id, method: 'cash', actor: 'admin' });
    await expect(env.db.pool.query(`UPDATE payroll_runs SET status = 'approved'`)).rejects.toThrow(/cannot be changed/);
    await expect(env.db.pool.query(`UPDATE payroll_runs SET paid_by = 'someone else'`)).rejects.toThrow(/cannot be changed/);
    await expect(env.db.pool.query(`DELETE FROM payroll_runs`)).rejects.toThrow(/can never be deleted/);
  });

  it('a locked period refuses new attendance, absences and adjustments that would change it; later periods are unaffected', async () => {
    const { env } = await lockedRun();
    const pool = env.db.pool;
    await expect(markAbsent(pool, { staffKey: 'zed', workDate: d(-8), reason: 'late entry', actor: 'm' })).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    await expect(recordAdjustment(pool, { staffKey: 'zed', type: 'bonus', amountCents: 5, effectiveDate: d(-1), reason: 'x', actor: 'a' })).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    await expect(clockIn(pool, { staffKey: 'zed', at: eat(d(0), '08:00:00') })).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    await expect(clockIn(pool, { staffKey: 'zed', at: eat(d(60), '08:00:00') })).resolves.toBeDefined();
    await expect(recordAdjustment(pool, { staffKey: 'zed', type: 'bonus', amountCents: 5, effectiveDate: d(60), reason: 'next period', actor: 'a' })).resolves.toBeDefined();
  });

  it('two locked runs can never cover the same day, so nobody is paid twice for it', async () => {
    const env = await fresh();
    await smallPayroll(env);
    // Overlap by days, but neither includes today, so no order is shared and the period rule itself has to stop it.
    const first = await generateDraft(ctx(env), { from: d(-10), to: d(-5), actor: 'm' });
    const overlapping = await generateDraft(ctx(env), { from: d(-8), to: d(-1), actor: 'm' });   // made while both are still drafts
    await approveRun(ctx(env), { runId: first.id, actor: 'admin' });
    await expect(approveRun(ctx(env), { runId: overlapping.id, actor: 'admin' })).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    expect((await getRun(env.db.pool, overlapping.id))!.status).toBe('draft');
    // the database enforces it too, whatever the service does
    await expect(env.db.pool.query(`UPDATE payroll_runs SET status = 'approved', approved_by = 'x', approved_at = now(), checksum = 'x' WHERE id = $1`, [overlapping.id])).rejects.toThrow(/payroll_locked_periods_dont_overlap|conflicting key/);
    // new drafts that touch a locked period are refused; the next period is fine
    await expect(generateDraft(ctx(env), { from: d(-7), to: d(-7), actor: 'm' })).rejects.toMatchObject({ code: 'PERIOD_LOCKED' });
    await expect(generateDraft(ctx(env), { from: d(-4), to: d(5), actor: 'm' })).resolves.toBeDefined();
  });

  it('an order earns commission in one run only (the commissioned-orders record), enforced in the service and the database', async () => {
    const env = await fresh();
    const { order } = await smallPayroll(env);
    const draft = await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' });
    // Pretend another run already commissioned this order.
    const other = await env.db.pool.query<{ id: number }>(`INSERT INTO payroll_runs (period_start, period_end, created_by) VALUES ($1, $2, 'x') RETURNING id`, [d(100), d(101)]);
    await env.db.pool.query(`INSERT INTO commissioned_orders (order_ref, run_id, staff_key, units, total_cents, secured_at) VALUES ($1, $2, 'zed', 2, 1000000, now())`, [order.orderRef, other.rows[0]!.id]);
    await expect(approveRun(ctx(env), { runId: draft.id, actor: 'admin' })).rejects.toMatchObject({ code: 'COMMISSION_ALREADY_PAID' });
    await expect(env.db.pool.query(`INSERT INTO commissioned_orders (order_ref, run_id, staff_key, units, total_cents, secured_at) VALUES ($1, $2, 'zed', 2, 1000000, now())`, [order.orderRef, draft.id])).rejects.toThrow(/duplicate key/);
  });

  it('a draft\'s arithmetic must add up: the database refuses an item whose figures disagree', async () => {
    const env = await fresh();
    await smallPayroll(env);
    const draft = await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' });
    await expect(env.db.pool.query(`UPDATE payroll_items SET net_cents = net_cents + 100 WHERE run_id = $1`, [draft.id])).rejects.toThrow(/net_is_gross_minus_deductions|payable_and_shortfall/);
    await expect(env.db.pool.query(`UPDATE payroll_items SET commission_cents = commission_cents + 1, gross_cents = gross_cents + 1, net_cents = net_cents + 1, payable_cents = payable_cents + 1 WHERE run_id = $1`, [draft.id])).rejects.toThrow(/commission_is_units_times_rate/);
  });
});

describe('the nightly integrity check watches locked runs and commission (Rules 8 and 9)', () => {
  it('passes on a locked, paid run', async () => {
    const env = await fresh();
    await smallPayroll(env);
    const run = await approveRun(ctx(env), { runId: (await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' })).id, actor: 'admin' });
    await markRunPaid(ctx(env), { runId: run.id, method: 'cash', actor: 'admin' });
    expect((await runIntegrityChecks(env.db.pool)).violations).toEqual([]);
  });

  it('RULE 9: catches a locked run whose figures were altered, even with the database guards bypassed', async () => {
    const env = await fresh();
    await smallPayroll(env);
    const run = await approveRun(ctx(env), { runId: (await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' })).id, actor: 'admin' });
    const c = await env.db.pool.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query(`UPDATE payroll_item_lines SET amount_cents = amount_cents + 500 WHERE kind = 'retainer_day' AND id = (SELECT min(id) FROM payroll_item_lines WHERE kind = 'retainer_day')`);
    } finally { await c.query('RESET session_replication_role'); c.release(); }
    const v = (await runIntegrityChecks(env.db.pool)).violations;
    expect(v.find((x) => x.check === 'locked_run_unchanged')).toMatchObject({ rule: 9 });
    expect(v.find((x) => x.check === 'locked_run_unchanged')!.message).toContain(`run ${run.id}`);
  });

  it('RULE 8: catches commission paid on an order whose money is not secure', async () => {
    const env = await fresh();
    await smallPayroll(env);
    const run = await approveRun(ctx(env), { runId: (await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' })).id, actor: 'admin' });
    const { dispatchedUnpaid } = await import('./payrollHelpers.js');
    const unpaid = await dispatchedUnpaid({ env, staffKey: 'zed', units: 1, unitPrice: 50_000 });
    const c = await env.db.pool.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query(`INSERT INTO commissioned_orders (order_ref, run_id, staff_key, units, total_cents, secured_at) VALUES ($1, $2, 'zed', 1, 50000, now())`, [unpaid.orderRef, run.id]);
    } finally { await c.query('RESET session_replication_role'); c.release(); }
    const v = (await runIntegrityChecks(env.db.pool)).violations.map((x) => `${x.rule}:${x.check}`);
    expect(v).toContain('8:commission_secure');
  });

  it('RULE 8: catches a statement whose secured amounts do not add up to what was settled', async () => {
    const env = await fresh();
    const { secureByOrgRemittance } = await import('./payrollHelpers.js');
    await secureByOrgRemittance({ env, staffKey: 'zed', units: 1, unitPrice: 200_000 });
    const c = await env.db.pool.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query(`UPDATE org_statement_lines SET secured_cents = secured_cents + 1000`);
    } finally { await c.query('RESET session_replication_role'); c.release(); }
    expect((await runIntegrityChecks(env.db.pool)).violations.map((x) => `${x.rule}:${x.check}`)).toContain('8:statement_secured_adds_up');
  });

  it('reports disabled protections on the payroll tables as rule 9', async () => {
    const env = await fresh();
    await env.db.pool.query('ALTER TABLE payroll_runs DISABLE TRIGGER payroll_runs_guard');
    await env.db.pool.query('ALTER TABLE payroll_items DISABLE TRIGGER payroll_items_locked');
    await env.db.pool.query('ALTER TABLE attendance_records DISABLE TRIGGER attendance_guard');
    const v = (await runIntegrityChecks(env.db.pool)).violations.filter((x) => x.check === 'guard_enabled');
    expect(v.map((x) => x.rule).sort((a, b) => Number(a) - Number(b))).toEqual([7, 9, 9]);
  });
});

