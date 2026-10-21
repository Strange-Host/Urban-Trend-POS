import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/db/migrate.js';
import { attendanceFor, clockIn, clockOut, markAbsent } from '../src/payroll/attendance.js';
import { previewPayroll } from '../src/payroll/calculate.js';
import { addCommissionPlan, adjustmentsFor, profileFor, profilesOnPayroll, recordAdjustment, setPayProfile } from '../src/payroll/profiles.js';
import { exportRunCsv, kes, payslip, renderPayslip, salaryTable, staffBreakdown } from '../src/payroll/reports.js';
import { approveRun, generateDraft } from '../src/payroll/runs.js';
import { shopDate } from '../src/payroll/time.js';
import { makeTestDb } from './helpers.js';
import { makeEnv, type Env } from './orderHelpers.js';
import { PERIOD, d, eat, secureByPaybill, smallPayroll } from './payrollHelpers.js';

const envs: Env[] = [];
const dirs: string[] = [];
afterAll(async () => { for (const e of envs) await e.db.drop(); dirs.forEach((x) => rmSync(x, { recursive: true, force: true })); });
const fresh = async () => { const e = await makeEnv(); envs.push(e); return e; };
const ctx = (env: Env) => ({ pool: env.db.pool });

describe('attendance', () => {
  it('clocks in and out, and the day is the shop\'s date (East Africa Time)', async () => {
    const env = await fresh();
    const inRec = await clockIn(env.db.pool, { staffKey: 'ann', at: new Date('2026-10-31T22:30:00Z') }); // 01:30 on 1 November in Nairobi
    expect(inRec.workDate).toBe('2026-11-01');
    const out = await clockOut(env.db.pool, { staffKey: 'ann', at: new Date('2026-11-01T11:00:00Z') });
    expect(out.clockOutAt).toEqual(new Date('2026-11-01T11:00:00Z'));
    expect(shopDate(new Date('2026-10-31T20:59:59Z'))).toBe('2026-10-31');
    expect(shopDate(new Date('2026-10-31T21:00:00Z'))).toBe('2026-11-01');
  });

  it('a clock-out after midnight closes the previous day\'s clock-in', async () => {
    const env = await fresh();
    await clockIn(env.db.pool, { staffKey: 'ann', at: eat(d(-50), '20:00:00') });
    const out = await clockOut(env.db.pool, { staffKey: 'ann', at: eat(d(-49), '01:00:00') });
    expect(out.workDate).toBe(d(-50));
  });

  it('one record per person per day; no clock-out without a clock-in; the clock-out is set once', async () => {
    const env = await fresh();
    await clockIn(env.db.pool, { staffKey: 'ann', at: eat(d(-40), '08:00:00') });
    await expect(clockIn(env.db.pool, { staffKey: 'ann', at: eat(d(-40), '09:00:00') })).rejects.toMatchObject({ code: 'ALREADY_RECORDED' });
    await expect(clockOut(env.db.pool, { staffKey: 'nobody', at: new Date() })).rejects.toMatchObject({ code: 'NOT_CLOCKED_IN' });
    await expect(clockOut(env.db.pool, { staffKey: 'ann', at: eat(d(-40), '07:00:00') })).rejects.toMatchObject({ code: 'CLOCK_OUT_BEFORE_IN' });
    await clockOut(env.db.pool, { staffKey: 'ann', at: eat(d(-40), '16:00:00') });
    await expect(clockOut(env.db.pool, { staffKey: 'ann', at: eat(d(-40), '17:00:00') })).rejects.toMatchObject({ code: 'NOT_CLOCKED_IN' });
    await expect(clockIn(env.db.pool, { staffKey: ' ' })).rejects.toMatchObject({ code: 'ATTENDANCE_NO_STAFF' });
  });

  it('an absence needs a date, a reason and who recorded it, and cannot share a day with a clock-in', async () => {
    const env = await fresh();
    await clockIn(env.db.pool, { staffKey: 'ann', at: eat(d(-30), '08:00:00') });
    await expect(markAbsent(env.db.pool, { staffKey: 'ann', workDate: d(-30), reason: 'x', actor: 'm' })).rejects.toMatchObject({ code: 'ALREADY_RECORDED' });
    await expect(markAbsent(env.db.pool, { staffKey: 'ann', workDate: d(-29), reason: ' ', actor: 'm' })).rejects.toMatchObject({ code: 'ABSENCE_REASON_REQUIRED' });
    await expect(markAbsent(env.db.pool, { staffKey: 'ann', workDate: '29/10/2026', reason: 'x', actor: 'm' })).rejects.toMatchObject({ code: 'PAY_BAD_DATE' });
    await expect(markAbsent(env.db.pool, { staffKey: 'ann', workDate: d(-29), reason: 'x', actor: '' })).rejects.toMatchObject({ code: 'PAY_NO_ACTOR' });
    await markAbsent(env.db.pool, { staffKey: 'ann', workDate: d(-29), reason: 'Sick, no note', actor: 'manager' });
    expect((await attendanceFor(env.db.pool, 'ann', d(-31), d(-28))).map((r) => [r.workDate, r.clockInAt !== null, r.absenceReason])).toEqual([[d(-30), true, null], [d(-29), false, 'Sick, no note']]);
  });

  it('attendance records cannot be edited (a clock-out can be added once) or deleted', async () => {
    const env = await fresh();
    await clockIn(env.db.pool, { staffKey: 'ann', at: eat(d(-30), '08:00:00') });
    await expect(env.db.pool.query(`UPDATE attendance_records SET clock_in_at = clock_in_at - interval '2 hours'`)).rejects.toThrow(/never changes/);
    await expect(env.db.pool.query(`DELETE FROM attendance_records`)).rejects.toThrow(/cannot be deleted/);
    await expect(env.db.pool.query(`TRUNCATE attendance_records`)).rejects.toThrow(/immutable/);
    await clockOut(env.db.pool, { staffKey: 'ann', at: eat(d(-30), '16:00:00') });
    await expect(env.db.pool.query(`UPDATE attendance_records SET clock_out_at = clock_out_at + interval '1 hour'`)).rejects.toThrow(/never changes/);
    await expect(env.db.pool.query(`INSERT INTO attendance_records (staff_key, work_date, recorded_by) VALUES ('x', '2026-01-01', 'm')`)).rejects.toThrow(/clocked_in_or_absent/);
  });
});

describe('pay profiles, commission plans and adjustments', () => {
  it('a profile is versioned by date; the one in force on the LAST day of the period applies to the whole period', async () => {
    const env = await fresh();
    const pool = env.db.pool;
    await setPayProfile(pool, { staffKey: 'ann', effectiveFrom: d(-30), dailyRetainerCents: 10_000, actor: 'a' });
    await setPayProfile(pool, { staffKey: 'ann', effectiveFrom: d(5), dailyRetainerCents: 20_000, actor: 'a' });
    expect(await profileFor(pool, 'ann', d(-31))).toBeNull();
    expect((await profileFor(pool, 'ann', d(0)))!.dailyRetainerCents).toBe(10_000);
    expect((await profileFor(pool, 'ann', d(5)))!.dailyRetainerCents).toBe(20_000);
    await clockIn(pool, { staffKey: 'ann', at: eat(d(-3), '08:00:00') });
    await clockIn(pool, { staffKey: 'ann', at: eat(d(-2), '08:00:00') });
    expect((await previewPayroll(pool, { from: d(-10), to: d(0) }))[0]!.retainerCents).toBe(20_000);   // period ends before the change
    expect((await previewPayroll(pool, { from: d(-10), to: d(10) }))[0]!.retainerCents).toBe(40_000);  // period ends after: new rate for all of it
    expect((await profilesOnPayroll(pool, d(-31)))).toEqual([]);
  });

  it('someone whose profile starts after the period is not on that period\'s payroll', async () => {
    const env = await fresh();
    await setPayProfile(env.db.pool, { staffKey: 'late-joiner', effectiveFrom: d(30), dailyRetainerCents: 10_000, actor: 'a' });
    expect(await previewPayroll(env.db.pool, PERIOD())).toEqual([]);
  });

  it('profiles and plans are never edited, and are validated', async () => {
    const env = await fresh();
    const pool = env.db.pool;
    const plan = await addCommissionPlan(pool, { name: 'P', targetCents: 100, rateBelow70Cents: 1, rate70Cents: 2, rate80Cents: 3, actor: 'a' });
    await setPayProfile(pool, { staffKey: 'ann', effectiveFrom: d(-5), dailyRetainerCents: 1, commissionPlanId: plan.id, actor: 'a' });
    await expect(pool.query(`UPDATE commission_plans SET rate_80_cents = 999`)).rejects.toThrow(/immutable/);
    await expect(pool.query(`UPDATE pay_profiles SET daily_retainer_cents = 999`)).rejects.toThrow(/immutable/);
    await expect(pool.query(`DELETE FROM pay_profiles`)).rejects.toThrow(/immutable/);
    await expect(setPayProfile(pool, { staffKey: 'ann', effectiveFrom: d(-5), dailyRetainerCents: 2, actor: 'a' })).rejects.toMatchObject({ code: 'PROFILE_EXISTS' });
    await expect(setPayProfile(pool, { staffKey: 'bob', effectiveFrom: d(-5), dailyRetainerCents: 2, commissionPlanId: 99_999, actor: 'a' })).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
    await expect(setPayProfile(pool, { staffKey: 'bob', effectiveFrom: '2026-13-01', dailyRetainerCents: 2, actor: 'a' })).rejects.toMatchObject({ code: 'PAY_BAD_DATE' });
    await expect(setPayProfile(pool, { staffKey: 'bob', effectiveFrom: d(0), dailyRetainerCents: 2, workdayStartMinute: 2000, actor: 'a' })).rejects.toMatchObject({ code: 'PAY_BAD_VALUE' });
    await expect(setPayProfile(pool, { staffKey: 'bob', effectiveFrom: d(0), dailyRetainerCents: -1, actor: 'a' })).rejects.toMatchObject({ code: 'PAY_BAD_AMOUNT' });
    await expect(setPayProfile(pool, { staffKey: 'bob', effectiveFrom: d(0), dailyRetainerCents: 1.5, actor: 'a' })).rejects.toMatchObject({ code: 'PAY_BAD_AMOUNT' });
    await expect(setPayProfile(pool, { staffKey: ' ', effectiveFrom: d(0), dailyRetainerCents: 1, actor: 'a' })).rejects.toMatchObject({ code: 'PAY_NO_STAFF' });
    await expect(setPayProfile(pool, { staffKey: 'bob', effectiveFrom: d(0), dailyRetainerCents: 1, actor: '' })).rejects.toMatchObject({ code: 'PAY_NO_ACTOR' });
    await expect(addCommissionPlan(pool, { name: ' ', targetCents: 1, rateBelow70Cents: 0, rate70Cents: 0, rate80Cents: 0, actor: 'a' })).rejects.toMatchObject({ code: 'PLAN_NO_NAME' });
    await expect(addCommissionPlan(pool, { name: 'x', targetCents: 0, rateBelow70Cents: 0, rate70Cents: 0, rate80Cents: 0, actor: 'a' })).rejects.toMatchObject({ code: 'PLAN_BAD_TARGET' });
  });

  it('someone with no commission plan earns no commission, even on secure sales', async () => {
    const env = await fresh();
    await setPayProfile(env.db.pool, { staffKey: 'manager-joe', effectiveFrom: d(-30), dailyRetainerCents: 0, actor: 'a' });
    await secureByPaybill({ env, staffKey: 'manager-joe', units: 3, unitPrice: 100_000 });
    const item = (await previewPayroll(env.db.pool, PERIOD()))[0]!;
    expect(item).toMatchObject({ unitsSold: 0, commissionCents: 0, tier: null, achievedSalesCents: 0 });
  });

  it('adjustments: a positive amount, a type, a reason and a date; never edited', async () => {
    const env = await fresh();
    const pool = env.db.pool;
    const base = { staffKey: 'ann', type: 'salary_advance' as const, amountCents: 5_000, effectiveDate: d(-5), reason: 'Rent', actor: 'a' };
    const a = await recordAdjustment(pool, base);
    expect(a).toMatchObject({ type: 'salary_advance', amountCents: 5_000, effectiveDate: d(-5) });
    // @ts-expect-error: not a real type
    await expect(recordAdjustment(pool, { ...base, type: 'gift' })).rejects.toMatchObject({ code: 'ADJUSTMENT_BAD_TYPE' });
    await expect(recordAdjustment(pool, { ...base, amountCents: 0 })).rejects.toMatchObject({ code: 'ADJUSTMENT_BAD_AMOUNT' });
    await expect(recordAdjustment(pool, { ...base, amountCents: -5 })).rejects.toMatchObject({ code: 'ADJUSTMENT_BAD_AMOUNT' });
    await expect(recordAdjustment(pool, { ...base, reason: '  ' })).rejects.toMatchObject({ code: 'ADJUSTMENT_REASON_REQUIRED' });
    await expect(recordAdjustment(pool, { ...base, effectiveDate: 'tomorrow' })).rejects.toMatchObject({ code: 'PAY_BAD_DATE' });
    await expect(recordAdjustment(pool, { ...base, actor: '' })).rejects.toMatchObject({ code: 'PAY_NO_ACTOR' });
    await expect(recordAdjustment(pool, { ...base, staffKey: '' })).rejects.toMatchObject({ code: 'PAY_NO_STAFF' });
    await expect(pool.query(`UPDATE payroll_adjustments SET amount_cents = 1`)).rejects.toThrow(/immutable/);
    await expect(pool.query(`DELETE FROM payroll_adjustments`)).rejects.toThrow(/immutable/);
    expect((await adjustmentsFor(pool, 'ann', d(-10), d(0))).map((x) => x.id)).toEqual([a.id]);
    expect(await adjustmentsFor(pool, 'ann', d(1), d(10))).toEqual([]);
  });
});

describe('reports: salary table, breakdown, payslip, CSV', () => {
  it('kes() formats cents exactly, including negatives', () => {
    expect([0, 5, 50, 100, 123_456, -5, -5_000, 100_000_000].map(kes)).toEqual(['0.00', '0.05', '0.50', '1.00', '1234.56', '-0.05', '-50.00', '1000000.00']);
  });

  it('the salary table is live until a run is locked, then shows the frozen figures', async () => {
    const env = await fresh();
    await smallPayroll(env);
    const live = await salaryTable(env.db.pool, PERIOD());
    expect(live).toMatchObject({ source: 'live', runId: null });
    expect(live.rows.map((r) => r.staffKey)).toEqual(['zed']);
    expect(live.totals.netCents).toBe(26_000);
    const run = await approveRun(ctx(env), { runId: (await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' })).id, actor: 'admin' });
    expect(await salaryTable(env.db.pool, PERIOD())).toMatchObject({ source: 'locked', runId: run.id });
    // a different period is live again
    expect((await salaryTable(env.db.pool, { from: d(30), to: d(40) })).source).toBe('live');
  });

  it('a person\'s full breakdown, live or locked; unknown people are 404s', async () => {
    const env = await fresh();
    await smallPayroll(env);
    const live = await staffBreakdown(env.db.pool, 'zed', PERIOD());
    expect(live.source).toBe('live');
    expect(live.item.lines.map((l) => l.kind).sort()).toEqual(['commission_order', 'retainer_day', 'retainer_day']);
    await expect(staffBreakdown(env.db.pool, 'ghost', PERIOD())).rejects.toMatchObject({ code: 'STAFF_NOT_ON_PAYROLL' });
    await approveRun(ctx(env), { runId: (await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' })).id, actor: 'admin' });
    expect((await staffBreakdown(env.db.pool, 'zed', PERIOD())).source).toBe('locked');
    await expect(staffBreakdown(env.db.pool, 'ghost', PERIOD())).rejects.toMatchObject({ code: 'STAFF_NOT_IN_RUN' });
  });

  it('payslips and CSV come only from a LOCKED run', async () => {
    const env = await fresh();
    await smallPayroll(env);
    const draft = await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' });
    await expect(payslip(env.db.pool, draft.id, 'zed')).rejects.toMatchObject({ code: 'RUN_NOT_LOCKED' });
    await expect(exportRunCsv(env.db.pool, draft.id)).rejects.toMatchObject({ code: 'RUN_NOT_LOCKED' });
    await approveRun(ctx(env), { runId: draft.id, actor: 'admin' });
    await expect(payslip(env.db.pool, draft.id, 'ghost')).rejects.toMatchObject({ code: 'STAFF_NOT_IN_RUN' });
    await expect(payslip(env.db.pool, 999_999, 'zed')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
    await expect(exportRunCsv(env.db.pool, 999_999)).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
  });

  it('the CSV is exactly right: columns, KES amounts, a totals row', async () => {
    const env = await fresh();
    await smallPayroll(env);
    const run = await approveRun(ctx(env), { runId: (await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' })).id, actor: 'admin' });
    expect(await exportRunCsv(env.db.pool, run.id)).toBe([
      'staff,days_worked,retainer,units_sold,commission,bonuses,gross,late,absence,missing_hours,advances,loss_deductions,deductions,net,payable,owed_back',
      'zed,2,200.00,2,60.00,0.00,260.00,0.00,0.00,0.00,0.00,0.00,0.00,260.00,260.00,0.00',
      'TOTAL,,,,60.00,,260.00,,,,,,0.00,260.00,260.00,0.00',
      '',
    ].join('\r\n'));
  });

  it('the CSV cannot be turned into a spreadsheet formula by a staff name, and quotes awkward names', async () => {
    const env = await fresh();
    const names = ['=HYPERLINK("http://evil.example","click")', '+254700111222', '-2+3', '@SUM(A1)', 'Doe, John', 'Line\nBreak'];
    for (const staffKey of names) {
      await setPayProfile(env.db.pool, { staffKey, effectiveFrom: d(-30), dailyRetainerCents: 10_000, actor: 'a' });
      await clockIn(env.db.pool, { staffKey, at: eat(d(-3), '08:00:00') });
    }
    const run = await approveRun(ctx(env), { runId: (await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' })).id, actor: 'admin' });
    const csv = await exportRunCsv(env.db.pool, run.id);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""click"")",1,100.00`); // shown as text, not executed
    expect(csv).toContain(`'+254700111222,1,`);
    expect(csv).toContain(`'-2+3,1,`);
    expect(csv).toContain(`'@SUM(A1),1,`);
    expect(csv).toContain(`"Doe, John",1,`);
    expect(csv).toContain(`"Line\nBreak",1,`);
    // Parse the CSV properly and check the first cell of EVERY record: none may begin with a formula character.
    const records: string[][] = [];
    let row: string[] = [], cell = '', quoted = false;
    for (let i = 0; i < csv.length; i++) {
      const ch = csv[i]!;
      if (quoted) { if (ch === '"' && csv[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; }
      else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\r' && csv[i + 1] === '\n') { row.push(cell); records.push(row); row = []; cell = ''; i++; }
      else cell += ch;
    }
    const staffCells = records.slice(1, -1).map((r) => r[0]!);   // skip the header and the TOTAL row
    expect(staffCells).toHaveLength(names.length);
    for (const c of staffCells) expect(c[0], c).not.toMatch(/[=+\-@\t\r]/);
    expect(staffCells.sort()).toEqual(names.map((n) => (/^[=+\-@]/.test(n) ? `'${n}` : n)).sort());
  });

  it('a payslip shows the earnings, the deductions, the net and the detail; a shortfall is stated plainly', async () => {
    const env = await fresh();
    await smallPayroll(env);
    await setPayProfile(env.db.pool, { staffKey: 'owes', effectiveFrom: d(-30), dailyRetainerCents: 0, actor: 'a' });
    await recordAdjustment(env.db.pool, { staffKey: 'owes', type: 'salary_advance', amountCents: 12_345, effectiveDate: d(-5), reason: 'Advance', actor: 'a' });
    const run = await approveRun(ctx(env), { runId: (await generateDraft(ctx(env), { ...PERIOD(), actor: 'm' })).id, actor: 'admin' });
    const zed = renderPayslip(await payslip(env.db.pool, run.id, 'zed'));
    expect(zed).toContain('PAYSLIP');
    expect(zed).toContain('Staff:   zed');
    expect(zed).toMatch(/Daily retainer \(2 days\)\s+200\.00/);
    expect(zed).toMatch(/Commission \(2 units, tier <70%\)\s+60\.00/);
    expect(zed).toMatch(/NET PAY\s+260\.00/);
    expect(zed).toMatch(/Order UT-[A-Z0-9]{8}, 2 unit\(s\)/);
    const owes = renderPayslip(await payslip(env.db.pool, run.id, 'owes'));
    expect(owes).toMatch(/NET PAY\s+-123\.45/);
    expect(owes).toMatch(/Owed back \(deductions exceed earnings\)\s+123\.45/);
    expect(owes).toContain('Nothing is payable this period.');
  });
});

describe('migration 0005: statements made before it get their secured amounts backfilled', () => {
  it('allocates what a statement settled to its parcels oldest-first', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'utpos-mig5-'));
    dirs.push(dir);
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((x) => /^000[1-4]_/.test(x))) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(dir, f));
    const db = await makeTestDb();
    try {
      await runMigrations(db.pool, dir); // the database as it was before this phase
      const c = await db.pool.connect();
      try {
        await c.query('SET session_replication_role = replica'); // seed legacy-shaped rows directly
        const courier = (await c.query(`INSERT INTO couriers (kind, name, collects_payment, created_by) VALUES ('organization', 'Old Org', true, 't') RETURNING id`)).rows[0].id;
        const col = async (ref: string, date: string) => (await c.query(
          `INSERT INTO org_collections (courier_id, order_ref, amount_cents, collected_on, entry_id, recorded_by) VALUES ($1, $2, 100000, $3, 1, 't') RETURNING id`, [courier, ref, date])).rows[0].id;
        const oldest = await col('UT-AAAAAAA2', '2026-01-01'), middle = await col('UT-AAAAAAA3', '2026-01-05'), newest = await col('UT-AAAAAAA4', '2026-01-09');
        const st = (await c.query(
          `INSERT INTO org_statements (courier_id, period_start, period_end, collections_cents, charge_entered_cents, fees_cents, remitted_cents, charge_variance_cents, cash_variance_cents, entry_id, created_by)
           VALUES ($1, '2026-01-01', '2026-01-31', 300000, 0, 20000, 230000, -20000, 50000, 1, 't') RETURNING id`, [courier])).rows[0].id;
        for (const id of [newest, oldest, middle]) await c.query(`INSERT INTO org_statement_lines (statement_id, collection_id) VALUES ($1, $2)`, [st, id]); // inserted out of order on purpose
      } finally { await c.query('RESET session_replication_role'); c.release(); }

      const result = await runMigrations(db.pool); // now apply 0005 (and anything after)
      expect(result.applied[0]).toBe('0005');
      const rows = (await db.pool.query(
        `SELECT k.order_ref, l.secured_cents FROM org_statement_lines l JOIN org_collections k ON k.id = l.collection_id ORDER BY k.collected_on`)).rows;
      expect(rows.map((r) => r.secured_cents)).toEqual([100_000, 100_000, 50_000]); // settled 250,000 = 230,000 remitted + 20,000 fees
      // the immutability guard is back on after the one-time backfill
      await expect(db.pool.query(`UPDATE org_statement_lines SET secured_cents = 0`)).rejects.toThrow(/immutable/);
    } finally { await db.drop(); }
  });
});
