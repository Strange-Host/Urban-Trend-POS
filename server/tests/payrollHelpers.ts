import { clockIn, clockOut, markAbsent } from '../src/payroll/attendance.js';
import { createStatement, recordOrgCollection } from '../src/couriers/organizations.js';
import { depositCustody, listOpenCustody } from '../src/orders/custody.js';
import { ingestPaybillPayment, recordShopCash } from '../src/orders/payments.js';
import { addCommissionPlan, recordAdjustment, setPayProfile } from '../src/payroll/profiles.js';
import { shopDate } from '../src/payroll/time.js';
import { dispatch, newOrder, newOrg, newRider, type Env } from './orderHelpers.js';

/** A shop-time (East Africa Time) instant from a date and a clock time. */
export const eat = (date: string, time: string) => new Date(`${date}T${time}+03:00`);
export const today = () => shopDate(new Date());
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
/** A day relative to today, shop time. */
export const d = (n: number) => addDays(today(), n);

/** The pay period every payroll test uses: wide enough that "now" is safely inside it. */
export const PERIOD = () => ({ from: d(-20), to: d(20) });

let n = 0;
const uniq = () => String(n++).padStart(4, '0');

// ----- orders at every stage of "is the money secure?" ---------------------------------------------------------------
type Base = { env: Env; staffKey: string; units: number; unitPrice: number };
const make = (b: Base) => newOrder(b.env, { assignedTo: b.staffKey, items: [{ name: 'Item', quantity: b.units, unitPriceCents: b.unitPrice }] });
const payFull = (env: Env, o: { orderRef: string; totalCents: number }) =>
  ingestPaybillPayment({ pool: env.db.pool }, { transCode: `PAYR${uniq()}${uniq()}`.slice(0, 12), amountCents: o.totalCents, accountRef: o.orderRef });

/** Paid by paybill, then dispatched: fully secure. */
export async function secureByPaybill(b: Base) {
  const o = await make(b);
  await payFull(b.env, o);
  await dispatch(b.env, o.orderRef);
  return o;
}
/** Collected by an organization AND the organization has remitted (statement settled exactly): fully secure. */
export async function secureByOrgRemittance(b: Base, fee = 20_000) {
  const org = await newOrg(b.env);
  const o = await make(b);
  await dispatch(b.env, o.orderRef, 'dispatcher', { courierId: org.id, feeCents: fee });
  const col = await recordOrgCollection({ pool: b.env.db.pool }, { courierId: org.id, orderRef: o.orderRef, amountCents: o.totalCents, actor: 'clerk' });
  await createStatement({ pool: b.env.db.pool }, { courierId: org.id, periodStart: d(-30), periodEnd: d(30), collectionIds: [col.id],
    chargeEnteredCents: fee, remittedCents: o.totalCents - fee, actor: 'manager' });
  return { ...o, org, collectionId: col.id };
}
/** Collected by an organization that has NOT remitted: not secure. */
export async function orgCollectedNotRemitted(b: Base) {
  const org = await newOrg(b.env);
  const o = await make(b);
  await dispatch(b.env, o.orderRef, 'dispatcher', { courierId: org.id, feeCents: 20_000 });
  await recordOrgCollection({ pool: b.env.db.pool }, { courierId: org.id, orderRef: o.orderRef, amountCents: o.totalCents, actor: 'clerk' });
  return o;
}
/** Shop cash taken. Secure only if `deposit` is true. */
export async function shopCash(b: Base, deposit: boolean) {
  const o = await make(b);
  const holder = `cashier-${uniq()}`;
  await recordShopCash({ pool: b.env.db.pool }, { orderRef: o.orderRef, amountCents: o.totalCents, reason: 'Customer paid in person', actor: holder });
  await dispatch(b.env, o.orderRef);
  if (deposit) {
    const rec = (await listOpenCustody(b.env.db.pool)).find((r) => r.orderRef === o.orderRef)!;
    await depositCustody({ pool: b.env.db.pool }, { custodyId: rec.id, actor: 'manager' });
  }
  return o;
}
/** Dispatched but never paid: not secure. */
export async function dispatchedUnpaid(b: Base) {
  const o = await make(b);
  await dispatch(b.env, o.orderRef);
  return o;
}
/** Paid but still waiting to be dispatched: not yet commissionable. */
export async function paidNotDispatched(b: Base) {
  const o = await make(b);
  await payFull(b.env, o);
  return o;
}

// ----- the worked test month ------------------------------------------------------------------------------------------
export const PLAN = { name: 'Standard', targetCents: 5_000_000, rateBelow70Cents: 3_000, rate70Cents: 3_000, rate80Cents: 5_000 };
export const RATES = { retainer: 30_000, lateFee: 5_000, absenceFee: 30_000, missingHourFee: 3_000 };

/**
 * Four staff, one pay period. Every figure is worked out by hand in the tests that use it.
 *   amina  7 days worked, late 3 times, short twice, 1 absence; 3 secure orders (66% of target); advance, loss, bonus
 *   brian  3 on-time days; 1 secure order worth 84% of target
 *   esther no attendance; 1 secure order worth 72% of target
 *   daudi  nothing but a salary advance: deductions exceed earnings
 */
export async function buildWorkedMonth(env: Env) {
  const pool = env.db.pool;
  const rider = await newRider(env);
  void rider;
  const plan = await addCommissionPlan(pool, { ...PLAN, actor: 'admin' });
  for (const staffKey of ['amina', 'brian', 'esther']) {
    await setPayProfile(pool, {
      staffKey, effectiveFrom: d(-30), dailyRetainerCents: staffKey === 'brian' ? 20_000 : staffKey === 'esther' ? 0 : RATES.retainer, commissionPlanId: plan.id,
      lateFeePerHourCents: RATES.lateFee, absenceFeeCents: RATES.absenceFee, missingHourFeeCents: RATES.missingHourFee, actor: 'admin',
    });
  }
  await setPayProfile(pool, { staffKey: 'daudi', effectiveFrom: d(-30), dailyRetainerCents: RATES.retainer, absenceFeeCents: RATES.absenceFee, actor: 'admin' });

  // ---- amina's attendance (every boundary on purpose)
  const A = 'amina';
  const day = (i: number) => d(-18 + i);
  await clockIn(pool, { staffKey: A, at: eat(day(0), '07:55:00') }); await clockOut(pool, { staffKey: A, at: eat(day(0), '16:00:00') }); // early, 8h05m: nothing
  await clockIn(pool, { staffKey: A, at: eat(day(1), '08:00:00') }); await clockOut(pool, { staffKey: A, at: eat(day(1), '16:00:00') }); // exactly 08:00:00 and exactly 8h: nothing
  await clockIn(pool, { staffKey: A, at: eat(day(2), '08:00:01') }); await clockOut(pool, { staffKey: A, at: eat(day(2), '17:00:00') }); // 1 second late: 1 hour
  await clockIn(pool, { staffKey: A, at: eat(day(3), '09:30:00') }); await clockOut(pool, { staffKey: A, at: eat(day(3), '18:00:00') }); // 1.5h late: 2 hours
  await clockIn(pool, { staffKey: A, at: eat(day(4), '08:00:00') }); await clockOut(pool, { staffKey: A, at: eat(day(4), '14:30:00') }); // 6.5h worked: 1.5h short = 2 hours
  await clockIn(pool, { staffKey: A, at: eat(day(5), '10:00:00') }); await clockOut(pool, { staffKey: A, at: eat(day(5), '17:00:00') }); // exactly 2h late; 7h worked = 1 hour short
  await markAbsent(pool, { staffKey: A, workDate: day(6), reason: 'No show, no call', actor: 'manager' });                                // absent
  await clockIn(pool, { staffKey: A, at: eat(day(7), '08:00:00') });                                                                  // no clock-out: no missing-hours fee

  // ---- brian: three on-time full days
  for (let i = 0; i < 3; i++) {
    await clockIn(pool, { staffKey: 'brian', at: eat(d(-18 + i), '07:50:00') });
    await clockOut(pool, { staffKey: 'brian', at: eat(d(-18 + i), '16:30:00') });
  }

  // ---- orders
  const mk = (staffKey: string, units: number, unitPrice: number): Base => ({ env, staffKey, units, unitPrice });
  const amina = {
    o1: await secureByPaybill(mk(A, 2, 750_000)),          // 1,500,000  counts
    o2: await secureByOrgRemittance(mk(A, 2, 500_000)),    // 1,000,000  counts (organization remitted)
    o3: await shopCash(mk(A, 1, 800_000), true),           //   800,000  counts (cash deposited)
    o4: await orgCollectedNotRemitted(mk(A, 1, 700_000)),  //   700,000  NOT secure: the organization has not remitted
    o5: await shopCash(mk(A, 1, 300_000), false),          //   300,000  NOT secure: cash still in someone's hands
    o6: await dispatchedUnpaid(mk(A, 1, 400_000)),         //   400,000  NOT secure: unpaid
    o7: await paidNotDispatched(mk(A, 1, 200_000)),        //   200,000  not yet: not dispatched
  };
  const brian = { o8: await secureByPaybill(mk('brian', 4, 1_050_000)) };   // 4,200,000 = 84%
  const esther = { o9: await secureByPaybill(mk('esther', 3, 1_200_000)) }; // 3,600,000 = 72%

  // ---- adjustments
  await recordAdjustment(pool, { staffKey: A, type: 'salary_advance', amountCents: 20_000, effectiveDate: d(-12), reason: 'Advance', actor: 'admin' });
  await recordAdjustment(pool, { staffKey: A, type: 'loss_deduction', amountCents: 5_000, effectiveDate: d(-11), reason: 'Broken display unit', actor: 'admin' });
  await recordAdjustment(pool, { staffKey: A, type: 'bonus', amountCents: 10_000, effectiveDate: d(-10), reason: 'Best month', actor: 'admin' });
  await recordAdjustment(pool, { staffKey: 'daudi', type: 'salary_advance', amountCents: 50_000, effectiveDate: d(-12), reason: 'Advance', actor: 'admin' });

  return { plan, amina, brian, esther };
}

/** A one-person payroll, cheap to build: zed, 2 days worked, 1 secure order. Net pay is 26,000 (20,000 retainer + 6,000 commission). */
export async function smallPayroll(env: Env) {
  const pool = env.db.pool;
  const plan = await addCommissionPlan(pool, { ...PLAN, actor: 'admin' });
  await setPayProfile(pool, { staffKey: 'zed', effectiveFrom: d(-30), dailyRetainerCents: 10_000, commissionPlanId: plan.id, lateFeePerHourCents: 5_000, absenceFeeCents: 30_000, missingHourFeeCents: 3_000, actor: 'admin' });
  await clockIn(pool, { staffKey: 'zed', at: eat(d(-3), '07:55:00') }); await clockOut(pool, { staffKey: 'zed', at: eat(d(-3), '16:10:00') });
  await clockIn(pool, { staffKey: 'zed', at: eat(d(-2), '07:58:00') }); await clockOut(pool, { staffKey: 'zed', at: eat(d(-2), '16:05:00') });
  const order = await secureByPaybill({ env, staffKey: 'zed', units: 2, unitPrice: 500_000 }); // 1,000,000 = 20%: low tier, 3,000 x 2 = 6,000
  return { plan, order };
}
