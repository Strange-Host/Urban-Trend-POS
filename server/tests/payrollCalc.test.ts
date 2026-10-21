import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attendanceDeductions, previewPayroll, tierFor } from '../src/payroll/calculate.js';
import { shopDate } from '../src/payroll/time.js';
import { securedOrders } from '../src/payroll/commission.js';
import { makeEnv, type Env } from './orderHelpers.js';
import { PERIOD, buildWorkedMonth } from './payrollHelpers.js';

let env: Env;
let month: Awaited<ReturnType<typeof buildWorkedMonth>>;
beforeAll(async () => { env = await makeEnv(); month = await buildWorkedMonth(env); }, 120_000);
afterAll(() => env.db.drop());

const by = async (staffKey: string) => (await previewPayroll(env.db.pool, PERIOD())).find((i) => i.staffKey === staffKey)!;

describe('the worked test month, calculated and checked against hand-worked figures', () => {
  it('amina: retainer, every late / short / absent boundary, secure-only commission, adjustments, net', async () => {
    const a = await by('amina');
    // Attendance: 7 days clocked in (one is the day with no clock-out), 1 absent.
    expect(a.daysWorked).toBe(7);
    expect(a.retainerCents).toBe(7 * 30_000);                 // 210,000
    // Late: 08:00:00 exactly is NOT late; 08:00:01 is 1 hour; 09:30 is 2 hours (1.5 rounded up); 10:00 is exactly 2 hours.
    expect(a.lateCents).toBe((1 + 2 + 2) * 5_000);            // 25,000
    // Missing hours: 8h exactly is fine; 6.5h worked is 2 hours short (1.5 up); 7h worked is 1 hour short. No clock-out: no fee.
    expect(a.missingHoursCents).toBe((2 + 1) * 3_000);        // 9,000
    expect(a.absenceCents).toBe(30_000);
    // Commission: only 3 of her 7 orders are fully secure = 1,500,000 + 1,000,000 + 800,000 = 3,300,000 of 5,000,000 = 66%.
    expect(a.achievedSalesCents).toBe(3_300_000);
    expect(a.targetCents).toBe(5_000_000);
    expect(a.achievementBp).toBe(6600);
    expect(a.tier).toBe('<70%');
    expect(a.unitsSold).toBe(2 + 2 + 1);
    expect(a.rateCents).toBe(3_000);
    expect(a.commissionCents).toBe(15_000);
    // Adjustments
    expect(a.bonusesCents).toBe(10_000);
    expect(a.advancesCents).toBe(20_000);
    expect(a.lossDeductionsCents).toBe(5_000);
    // Totals
    expect(a.grossCents).toBe(210_000 + 15_000 + 10_000);     // 235,000
    expect(a.deductionsCents).toBe(25_000 + 30_000 + 9_000 + 20_000 + 5_000); // 89,000
    expect(a.netCents).toBe(146_000);
    expect(a.payableCents).toBe(146_000);
    expect(a.shortfallCents).toBe(0);
  });

  it('amina\'s breakdown lists every line behind the totals, and the lines add up to them', async () => {
    const a = await by('amina');
    const kinds = a.lines.reduce<Record<string, number>>((m, l) => ({ ...m, [l.kind]: (m[l.kind] ?? 0) + 1 }), {});
    expect(kinds).toEqual({ retainer_day: 7, commission_order: 3, bonus: 1, late: 3, absence: 1, missing_hours: 2, salary_advance: 1, loss_deduction: 1 });
    const sum = (k: string) => a.lines.filter((l) => l.kind === k).reduce((s, l) => s + l.amountCents, 0);
    expect(sum('retainer_day')).toBe(a.retainerCents);
    expect(sum('commission_order')).toBe(a.commissionCents);
    expect(sum('late')).toBe(a.lateCents);
    expect(sum('missing_hours')).toBe(a.missingHoursCents);
    expect(sum('absence')).toBe(a.absenceCents);
    expect(sum('salary_advance')).toBe(a.advancesCents);
    expect(sum('loss_deduction')).toBe(a.lossDeductionsCents);
    expect(sum('bonus')).toBe(a.bonusesCents);
    const hours = a.lines.filter((l) => l.kind === 'late').map((l) => l.quantity).sort();
    expect(hours).toEqual([1, 2, 2]);
  });

  it('brian reaches 80%+ and earns the top rate per unit', async () => {
    const b = await by('brian');
    expect(b).toMatchObject({ daysWorked: 3, retainerCents: 60_000, achievedSalesCents: 4_200_000, achievementBp: 8400, tier: '>=80%', unitsSold: 4, rateCents: 5_000, commissionCents: 20_000, lateCents: 0, missingHoursCents: 0 });
    expect(b.netCents).toBe(80_000);
  });

  it('esther reaches 72% and earns the middle rate', async () => {
    const e = await by('esther');
    expect(e).toMatchObject({ daysWorked: 0, retainerCents: 0, achievementBp: 7200, tier: '70-80%', unitsSold: 3, rateCents: 3_000, commissionCents: 9_000, netCents: 9_000 });
  });

  it('daudi is paid nothing when deductions exceed earnings, and the shortfall is shown, not hidden', async () => {
    const dd = await by('daudi');
    expect(dd).toMatchObject({ grossCents: 0, deductionsCents: 50_000, netCents: -50_000, payableCents: 0, shortfallCents: 50_000, unitsSold: 0, tier: null, commissionCents: 0 });
  });

  it('the run totals add up', async () => {
    const items = await previewPayroll(env.db.pool, PERIOD());
    const sum = (k: 'grossCents' | 'deductionsCents' | 'netCents' | 'payableCents' | 'shortfallCents') => items.reduce((s, i) => s + i[k], 0);
    expect(items.map((i) => i.staffKey)).toEqual(['amina', 'brian', 'daudi', 'esther']);
    expect(sum('grossCents')).toBe(235_000 + 80_000 + 0 + 9_000);
    expect(sum('deductionsCents')).toBe(89_000 + 0 + 50_000 + 0);
    expect(sum('netCents')).toBe(146_000 + 80_000 - 50_000 + 9_000);
    expect(sum('payableCents')).toBe(146_000 + 80_000 + 0 + 9_000);
    expect(sum('shortfallCents')).toBe(50_000);
  });

  it('is deterministic: calculating twice gives identical figures', async () => {
    expect(JSON.stringify(await previewPayroll(env.db.pool, PERIOD()))).toBe(JSON.stringify(await previewPayroll(env.db.pool, PERIOD())));
  });
});

// Note: the two "starts earning once…" tests below deliberately change the fixture (a remittance, a deposit), so they run
// after the tests that need those orders to still be unsecured.
describe('RULE 8: commission only on secure money', () => {
  it('counts exactly the fully secure, dispatched orders', async () => {
    const secured = await securedOrders(env.db.pool, { staffKey: 'amina' });
    expect(secured.map((o) => o.orderRef).sort()).toEqual([month.amina.o1.orderRef, month.amina.o2.orderRef, month.amina.o3.orderRef].sort());
  });

  it.each([
    ['o4', 'an organization collected the money but has not remitted it'],
    ['o5', 'shop cash that has not been deposited'],
    ['o6', 'an order that has not been paid'],
    ['o7', 'a paid order that has not been dispatched'],
  ] as const)('does NOT count %s: %s', async (key, _why) => {
    const refs = (await securedOrders(env.db.pool)).map((o) => o.orderRef);
    expect(refs).not.toContain(month.amina[key].orderRef);
  });

  it('an organization\'s parcel only starts earning commission when the organization remits', async () => {
    const { createStatement } = await import('../src/couriers/organizations.js');
    const { db } = env;
    const o4 = month.amina.o4;
    const col = (await db.pool.query(`SELECT k.id, k.courier_id FROM org_collections k WHERE k.order_ref = $1`, [o4.orderRef])).rows[0];
    expect((await securedOrders(db.pool, { orderRefs: [o4.orderRef] }))).toEqual([]);
    await createStatement({ pool: db.pool }, { courierId: col.courier_id, periodStart: '2020-01-01', periodEnd: '2099-12-31', collectionIds: [col.id], chargeEnteredCents: 20_000, remittedCents: o4.totalCents - 20_000, actor: 'manager' });
    const now = await securedOrders(db.pool, { orderRefs: [o4.orderRef] });
    expect(now).toHaveLength(1);
    expect(now[0]!.staffKey).toBe('amina');
  });

  it('cash starts earning commission only once deposited', async () => {
    const { depositCustody, listOpenCustody } = await import('../src/orders/custody.js');
    const o5 = month.amina.o5;
    expect(await securedOrders(env.db.pool, { orderRefs: [o5.orderRef] })).toEqual([]);
    const rec = (await listOpenCustody(env.db.pool)).find((r) => r.orderRef === o5.orderRef)!;
    await depositCustody({ pool: env.db.pool }, { custodyId: rec.id, actor: 'manager' });
    expect(await securedOrders(env.db.pool, { orderRefs: [o5.orderRef] })).toHaveLength(1);
  });

  it('an order is counted on the day its money became secure, so a later filter window excludes it', async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000);
    expect(await securedOrders(env.db.pool, { staffKey: 'brian', from: tomorrow })).toEqual([]);
    expect((await securedOrders(env.db.pool, { staffKey: 'brian', to: tomorrow })).length).toBe(1);
  });

  it('a partly remitted organization statement secures its OLDEST parcels first, and a parcel only counts when covered in full', async () => {
    const { createStatement, recordOrgCollection } = await import('../src/couriers/organizations.js');
    const { newOrder, dispatch, newOrg } = await import('./orderHelpers.js');
    const org = await newOrg(env);
    const mk = async (daysAgo: number) => {
      const o = await newOrder(env, { assignedTo: 'amina', items: [{ name: 'X', quantity: 1, unitPriceCents: 100_000 }] });
      await dispatch(env, o.orderRef, 'd', { courierId: org.id, feeCents: 0, zeroReason: 'agreed' });
      const date = shopDate(new Date(Date.now() - daysAgo * 86_400_000));
      return { o, col: await recordOrgCollection({ pool: env.db.pool }, { courierId: org.id, orderRef: o.orderRef, amountCents: 100_000, collectedOn: date, actor: 'c' }) };
    };
    const oldest = await mk(9), middle = await mk(5), newest = await mk(1);
    // remits 250,000 of 300,000: covers the oldest two in full and half of the newest
    await createStatement({ pool: env.db.pool }, { courierId: org.id, periodStart: '2020-01-01', periodEnd: '2099-12-31', collectionIds: [newest.col.id, oldest.col.id, middle.col.id], chargeEnteredCents: 0, remittedCents: 250_000, actor: 'm' });
    const lines = (await env.db.pool.query(`SELECT k.order_ref, l.secured_cents FROM org_statement_lines l JOIN org_collections k ON k.id = l.collection_id WHERE k.courier_id = $1`, [org.id])).rows;
    const securedOf = (ref: string) => lines.find((l) => l.order_ref === ref)!.secured_cents;
    expect([securedOf(oldest.o.orderRef), securedOf(middle.o.orderRef), securedOf(newest.o.orderRef)]).toEqual([100_000, 100_000, 50_000]);
    const counted = (await securedOrders(env.db.pool, { orderRefs: [oldest.o.orderRef, middle.o.orderRef, newest.o.orderRef] })).map((o) => o.orderRef);
    expect(counted.sort()).toEqual([oldest.o.orderRef, middle.o.orderRef].sort()); // the half-covered newest parcel earns nothing yet
  });

  it('an order with no assigned staff member earns nobody commission', async () => {
    const { newOrder, dispatch } = await import('./orderHelpers.js');
    const { ingestPaybillPayment } = await import('../src/orders/payments.js');
    const o = await newOrder(env, { items: [{ name: 'X', quantity: 1, unitPriceCents: 10_000 }] });
    await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'NOBODY0001', amountCents: 10_000, accountRef: o.orderRef });
    await dispatch(env, o.orderRef);
    expect(await securedOrders(env.db.pool, { orderRefs: [o.orderRef] })).toEqual([]);
  });
});

describe('commission tiers and the 70% / 80% boundaries (exact, no rounding)', () => {
  it('uses basis points: 69.99% is the low tier, exactly 70% the middle, 79.99% the middle, exactly 80% the top', () => {
    expect(tierFor(6999)).toBe('<70%');
    expect(tierFor(7000)).toBe('70-80%');
    expect(tierFor(7999)).toBe('70-80%');
    expect(tierFor(8000)).toBe('>=80%');
    expect(tierFor(0)).toBe('<70%');
    expect(tierFor(25_000)).toBe('>=80%'); // over-achieving is still the top tier
  });
});

describe('attendance deductions, exactly', () => {
  const profile = {
    id: 1, staffKey: 'x', effectiveFrom: '2026-01-01', dailyRetainerCents: 30_000, commissionPlan: null, workdayStartMinute: 480, expectedMinutes: 480,
    lateFeePerHourCents: 5_000, absenceFeeCents: 30_000, missingHourFeeCents: 3_000,
  };
  const rec = (date: string, inT: string | null, outT: string | null) => ({
    staffKey: 'x', workDate: date, clockInAt: inT ? new Date(`${date}T${inT}+03:00`) : null, clockOutAt: outT ? new Date(`${date}T${outT}+03:00`) : null,
    absenceReason: inT ? null : 'absent',
  });

  it.each([
    ['07:59:59', 0], ['08:00:00', 0], ['08:00:01', 1], ['08:59:59', 1], ['09:00:00', 1], ['09:00:01', 2], ['12:00:00', 4],
  ])('clocking in at %s is %i hour(s) late', (time, hours) => {
    const r = attendanceDeductions([rec('2026-11-02', time, null)], profile);
    expect(r.late).toBe(hours * 5_000);
  });

  it.each([
    ['16:00:00', 0], ['15:59:59', 1], ['15:00:00', 1], ['14:59:59', 2], ['08:00:01', 8],
  ])('working 08:00 to %s is %i hour(s) short', (outT, hours) => {
    const r = attendanceDeductions([rec('2026-11-02', '08:00:00', outT)], profile);
    expect(r.missing).toBe(hours * 3_000);
  });

  it('the shop clock is East Africa Time: 05:00 UTC is 08:00 and on time; 05:00:01 UTC is late', () => {
    const onTime = attendanceDeductions([{ ...rec('2026-11-02', null, null), clockInAt: new Date('2026-11-02T05:00:00Z'), absenceReason: null }], profile);
    const late = attendanceDeductions([{ ...rec('2026-11-02', null, null), clockInAt: new Date('2026-11-02T05:00:01Z'), absenceReason: null }], profile);
    expect([onTime.late, late.late]).toEqual([0, 5_000]);
  });

  it('an absent day costs the absence fee only; it is never also late or short', () => {
    const r = attendanceDeductions([rec('2026-11-02', null, null)], profile);
    expect(r).toMatchObject({ absence: 30_000, late: 0, missing: 0, daysWorked: 0 });
  });

  it('a different start time and day length come from the pay profile', () => {
    const p = { ...profile, workdayStartMinute: 9 * 60 + 30, expectedMinutes: 450 }; // 09:30 start, 7.5 hour day
    const r = attendanceDeductions([rec('2026-11-02', '09:30:00', '16:59:00'), rec('2026-11-03', '09:31:00', '17:01:00')], p);
    expect(r.late).toBe(5_000);                                       // 1 minute late on the second day = 1 hour
    expect(r.missing).toBe(3_000);                                    // first day: 7h29m is 1 minute short of 7.5h = 1 hour
  });
});
