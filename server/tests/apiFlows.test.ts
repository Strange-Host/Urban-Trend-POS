import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { createLogger } from '../src/logger.js';
import { ingestPaybillPayment } from '../src/orders/payments.js';
import { shopDate } from '../src/payroll/time.js';
import { loggedIn } from './authHelpers.js';
import { makeTestDb, type TestDb } from './helpers.js';
import { KEY } from './orderHelpers.js';

let db: TestDb;
let app: ReturnType<typeof createApp>;
beforeAll(async () => { db = await makeTestDb(); await runMigrations(db.pool); app = createApp({ pool: db.pool, logger: createLogger('silent'), orderRefKey: KEY }); });
afterAll(() => db.drop());

const as = (u: { auth: string }) => ({ set: (r: request.Test) => r.set('Authorization', u.auth) });
const creds = (u: { username: string; password: string }) => ({ username: u.username, password: u.password });
let phone = 0;
const freshPhone = () => `0733${String(100000 + phone++)}`;

describe('an order from creation to delivery, over HTTP', () => {
  it('creates, dispatches with a courier, takes payment, records delivery, and shows up in the lists and at-risk page', async () => {
    const agent = await loggedIn(db.pool, 'cashier');
    const mgr = await loggedIn(db.pool, 'manager');
    const rider = (await as(mgr).set(request(app).post('/api/couriers/riders')).send({ name: 'Peter Rider', phone: '0700123456' })).body.courier;
    expect(rider.kind).toBe('rider');

    const created = await as(agent).set(request(app).post('/api/orders')).send({ customerName: 'Wanjiku', customerPhone: freshPhone(), items: [{ name: 'Sneakers', quantity: 1, unitPriceCents: 500_000 }] });
    expect(created.status).toBe(201);
    const ref = created.body.order.orderRef;
    expect(created.body.order.events[0].actor).toBe(agent.username);

    // a cashier may create but not dispatch
    expect((await as(agent).set(request(app).post(`/api/orders/${ref}/dispatch`)).send({ courierId: rider.id, packageFee: { amountCents: 30_000 } })).status).toBe(403);
    expect((await as(agent).set(request(app).post(`/api/orders/${ref}/confirm`)).send({})).status).toBe(403); // confirming is a manager's job too
    expect((await as(mgr).set(request(app).post(`/api/orders/${ref}/confirm`)).send({})).status).toBe(200);
    expect((await as(mgr).set(request(app).post(`/api/orders/${ref}/dispatch`)).send({ courierId: rider.id })).status).toBe(422); // no fee entered
    const disp = await as(mgr).set(request(app).post(`/api/orders/${ref}/dispatch`)).send({ courierId: rider.id, packageFee: { amountCents: 30_000 } });
    expect(disp.body.order).toMatchObject({ status: 'dispatched', dispatch: { courierName: 'Peter Rider', packageFeeCents: 30_000 } });

    // lists and lookups, in whatever spacing the ref was typed
    const found = await as(agent).set(request(app).get(`/api/orders/${encodeURIComponent(ref.toLowerCase())}`));
    expect(found.body.order.orderRef).toBe(ref);
    const list = await as(agent).set(request(app).get('/api/orders?status=dispatched&unpaid=true'));
    expect(list.body.orders.map((o: { orderRef: string }) => o.orderRef)).toContain(ref);
    expect(list.body.orders[0]).toMatchObject({ balanceCents: 500_000, courierName: 'Peter Rider' });

    // part payment arrives by paybill; the rest is cash at the shop (a manager exception)
    await ingestPaybillPayment({ pool: db.pool }, { transCode: 'FLOW000001', amountCents: 200_000, accountRef: ref });
    expect((await as(agent).set(request(app).post(`/api/orders/${ref}/shop-cash`)).send({ amountCents: 300_000, reason: 'Paid at counter' })).status).toBe(403);
    expect((await as(mgr).set(request(app).post(`/api/orders/${ref}/shop-cash`)).send({ amountCents: 300_000, reason: 'Paid at counter' })).status).toBe(201);
    const custody = await as(mgr).set(request(app).get('/api/custody'));
    expect(custody.body.records).toHaveLength(1);
    expect((await as(mgr).set(request(app).post(`/api/custody/${custody.body.records[0].id}/deposit`))).status).toBe(200);

    const att = await as(mgr).set(request(app).post(`/api/orders/${ref}/attempts`)).send({ outcome: 'delivered' });
    expect(att.body.order).toMatchObject({ status: 'delivered', paymentStatus: 'paid', balanceCents: 0 });
    expect((await as(agent).set(request(app).get('/api/orders?status=dispatched'))).body.orders.map((o: { orderRef: string }) => o.orderRef)).not.toContain(ref);

    // the rider is owed the package fee until an admin pays it
    const unpaid = await as(mgr).set(request(app).get(`/api/couriers/${rider.id}/unpaid`));
    expect(unpaid.body.items).toMatchObject([{ type: 'package_fee', amountCents: 30_000 }]);
    const admin = await loggedIn(db.pool, 'admin');
    expect((await as(mgr).set(request(app).post(`/api/couriers/${rider.id}/payouts`)).send({ method: 'cash' })).status).toBe(403);
    const payout = await as(admin).set(request(app).post(`/api/couriers/${rider.id}/payouts`)).send({ method: 'mpesa', paymentRef: 'QFLOW123' });
    expect(payout.status).toBe(201);
    expect(payout.body.payout.totalCents).toBe(30_000);
    expect((await as(mgr).set(request(app).get(`/api/couriers/${rider.id}`))).body.profile.owedCents).toBe(0);
    expect((await runIntegrityChecks(db.pool)).violations).toEqual([]);
  });

  it('refuses a duplicate active order with the existing reference, and a missing server key with a 503', async () => {
    const agent = await loggedIn(db.pool, 'cashier');
    const ph = freshPhone();
    const body = { customerName: 'Dup', customerPhone: ph, items: [{ name: 'X', quantity: 1, unitPriceCents: 10_000 }] };
    const first = await as(agent).set(request(app).post('/api/orders')).send(body);
    const second = await as(agent).set(request(app).post('/api/orders')).send(body);
    expect(second.status).toBe(409);
    expect(second.body.details.existingOrderRef).toBe(first.body.order.orderRef);
    const noKey = createApp({ pool: db.pool, logger: createLogger('silent') });
    expect((await as(agent).set(request(noKey).post('/api/orders')).send({ ...body, customerPhone: freshPhone() })).status).toBe(503);
  });

  it('matches suspense money to an order through the API', async () => {
    const agent = await loggedIn(db.pool, 'cashier');
    const mgr = await loggedIn(db.pool, 'manager');
    const o = (await as(agent).set(request(app).post('/api/orders')).send({ customerName: 'Susp', customerPhone: '0722555666', items: [{ name: 'X', quantity: 1, unitPriceCents: 80_000 }] })).body.order;
    await ingestPaybillPayment({ pool: db.pool }, { transCode: 'SUSP000001', amountCents: 80_000, accountRef: 'garbled', msisdn: '254722555666' });
    const items = (await as(mgr).set(request(app).get('/api/payments/suspense'))).body.items;
    const it = items.find((x: { transCode: string }) => x.transCode === 'SUSP000001');
    expect(it.remainingCents).toBe(80_000);
    const sug = await as(mgr).set(request(app).get(`/api/payments/suspense/${it.exceptionId}/suggestions`));
    expect(sug.status).toBe(200);
    const applied = await as(mgr).set(request(app).post(`/api/payments/suspense/${it.exceptionId}/apply`)).send({ orderRef: o.orderRef });
    expect(applied.status).toBe(200);
    expect((await as(agent).set(request(app).get(`/api/orders/${o.orderRef}`))).body.order.paymentStatus).toBe('paid');
    const risk = await as(mgr).set(request(app).get('/api/at-risk'));
    expect(risk.status).toBe(200);
    expect(risk.body).toHaveProperty('totalCents');
  });
});

describe('the till and sales, with a manager approving by password', () => {
  it('runs a shift: open, top-up, discounted sale needing approval, void, refund, close and sign-off', async () => {
    const cashier = await loggedIn(db.pool, 'cashier');
    const mgr = await loggedIn(db.pool, 'manager');
    const mgr2 = await loggedIn(db.pool, 'manager');

    expect((await as(cashier).set(request(app).get('/api/till/current'))).body.session).toBeNull();
    const sess = (await as(cashier).set(request(app).post('/api/till/sessions')).send({ openingFloatCents: 0 })).body.session;
    expect(sess).toMatchObject({ cashier: cashier.username, status: 'open' });
    expect((await as(cashier).set(request(app).post('/api/till/sessions')).send({ openingFloatCents: 0 })).status).toBe(409);

    // float: needs a second person, by their own password
    const noApproval = await as(cashier).set(request(app).post(`/api/till/sessions/${sess.id}/movements`)).send({ kind: 'top_up', amountCents: 100_000, reason: 'Opening float' });
    expect(noApproval.status).toBe(422);
    const wrongPw = await as(cashier).set(request(app).post(`/api/till/sessions/${sess.id}/movements`)).send({ kind: 'top_up', amountCents: 100_000, reason: 'Opening float', approval: { username: mgr.username, password: 'not-the-password' } });
    expect(wrongPw.status).toBe(401);
    const selfApproval = await as(mgr).set(request(app).post(`/api/till/sessions/${sess.id}/movements`)).send({ kind: 'top_up', amountCents: 1, reason: 'x', approval: creds(mgr) });
    expect(selfApproval.status).toBe(403); // not the owner of the session, and cannot approve themselves
    const cashierApprover = await loggedIn(db.pool, 'cashier');
    expect((await as(cashier).set(request(app).post(`/api/till/sessions/${sess.id}/movements`)).send({ kind: 'top_up', amountCents: 100_000, reason: 'Opening float', approval: creds(cashierApprover) })).body.error.code).toBe('APPROVER_NOT_ALLOWED');
    const topUp = await as(cashier).set(request(app).post(`/api/till/sessions/${sess.id}/movements`)).send({ kind: 'top_up', amountCents: 100_000, reason: 'Opening float', approval: creds(mgr) });
    expect(topUp.status).toBe(201);

    // a plain cash sale, then a 30% discount that needs a manager
    const sale1 = await as(cashier).set(request(app).post('/api/sales')).send({ items: [{ sku: 'SN-1', name: 'Sneakers', quantity: 2, unitPriceCents: 50_000 }], payments: [{ method: 'cash', amountCents: 100_000 }] });
    expect(sale1.status).toBe(201);
    const disc = { items: [{ name: 'Boots', quantity: 1, unitPriceCents: 100_000 }], saleDiscountCents: 30_000, discountReason: 'promotion', payments: [{ method: 'mobile_money', amountCents: 70_000, reference: 'QMPESA001' }], clientSaleId: 'pos-a-1' };
    const needs = await as(cashier).set(request(app).post('/api/sales')).send(disc);
    expect(needs.status).toBe(403);
    expect(needs.body.error.code).toBe('DISCOUNT_NEEDS_APPROVAL');
    const sale2 = await as(cashier).set(request(app).post('/api/sales')).send({ ...disc, approval: creds(mgr) });
    expect(sale2.status).toBe(201);
    const retry = await as(cashier).set(request(app).post('/api/sales')).send({ ...disc, approval: creds(mgr) });
    expect(retry.status).toBe(200); // the same clientSaleId is a replay, not a second sale
    expect(retry.body.sale.id).toBe(sale2.body.sale.id);

    // void needs a manager's password, and refunds the right way round
    expect((await as(cashier).set(request(app).post(`/api/sales/${sale1.body.sale.id}/void`)).send({ reason: 'Wrong item' })).status).toBe(422);
    expect((await as(cashier).set(request(app).post(`/api/sales/${sale1.body.sale.id}/void`)).send({ reason: 'Wrong item', approval: creds(cashier) })).body.error.code).toBe('APPROVER_IS_REQUESTER');
    const voided = await as(cashier).set(request(app).post(`/api/sales/${sale1.body.sale.id}/void`)).send({ reason: 'Wrong item', approval: creds(mgr2) });
    expect(voided.body.sale.status).toBe('voided');
    const refund = await as(cashier).set(request(app).post(`/api/sales/${sale2.body.sale.id}/refund`)).send({ items: [{ saleItemId: sale2.body.sale.items[0].id, quantity: 1 }], method: 'mobile_money', reason: 'Defective', approval: creds(mgr) });
    expect(refund.status).toBe(201);
    expect(refund.body.amountCents).toBe(70_000);

    // other people's sessions and sales are private to a cashier
    const other = await loggedIn(db.pool, 'cashier');
    expect((await as(other).set(request(app).get(`/api/till/sessions/${sess.id}`))).status).toBe(403);
    expect((await as(other).set(request(app).get(`/api/sales/${sale2.body.sale.id}`))).status).toBe(403);
    expect((await as(other).set(request(app).get('/api/sales'))).body.total).toBe(0);
    expect((await as(cashier).set(request(app).get('/api/sales'))).body.total).toBe(2);

    // close with a shortfall: needs a reason; a big one needs sign-off
    const exp = (await as(cashier).set(request(app).get(`/api/till/sessions/${sess.id}`))).body.expected;
    expect(exp).toEqual({ cash: 100_000, card: 0, mobile_money: 0 });
    const noReason = await as(cashier).set(request(app).post(`/api/till/sessions/${sess.id}/close`)).send({ counted: { cash: 40_000, card: 0, mobile_money: 0 } });
    expect(noReason.status).toBeGreaterThanOrEqual(400);
    const closed = await as(cashier).set(request(app).post(`/api/till/sessions/${sess.id}/close`)).send({ counted: { cash: 40_000, card: 0, mobile_money: 0 }, varianceReason: 'Short: change given wrongly' });
    expect(closed.status).toBe(200);
    expect(closed.body.session.signoffRequired).toBe(true);
    expect((await as(cashier).set(request(app).post(`/api/till/sessions/${sess.id}/signoff`))).status).toBe(403);
    expect((await as(mgr).set(request(app).get('/api/till/sessions?needsSignoff=true'))).body.total).toBeGreaterThanOrEqual(1);
    const signed = await as(mgr).set(request(app).post(`/api/till/sessions/${sess.id}/signoff`));
    expect(signed.body.session).toMatchObject({ status: 'signed_off', signedOffBy: mgr.username });
    expect((await runIntegrityChecks(db.pool)).violations).toEqual([]);

    // the manager's views of what just happened
    const disc2 = await as(mgr).set(request(app).get('/api/reports/discounts'));
    expect(disc2.body.rows.find((r: { cashier: string }) => r.cashier === cashier.username)).toMatchObject({ discountedSales: 1, approvedSales: 1 });
    const audit = await as(mgr).set(request(app).get(`/api/audit?actor=${cashier.username}&minRisk=2`));
    expect(audit.body.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['void', 'refund']));
    expect((await as(cashier).set(request(app).get('/api/audit'))).status).toBe(403);
  });
});

describe('couriers: costs, organizations and statements', () => {
  it('records a cost, has a manager approve it, and an organization collects and settles a statement', async () => {
    const mgr = await loggedIn(db.pool, 'manager');
    const agent = await loggedIn(db.pool, 'cashier');
    const org = (await as(mgr).set(request(app).post('/api/couriers/organizations')).send({ name: 'Fastline Couriers', collectsPayment: true, overdueLimitCents: 500_000, overdueAfterDays: 7 })).body.courier;
    expect((await as(mgr).set(request(app).post('/api/couriers/organizations')).send({ name: 'Fastline Couriers', collectsPayment: true })).status).toBe(409);

    const o = (await as(agent).set(request(app).post('/api/orders')).send({ customerName: 'Org Cust', customerPhone: freshPhone(), items: [{ name: 'X', quantity: 1, unitPriceCents: 200_000 }] })).body.order;
    await as(mgr).set(request(app).post(`/api/orders/${o.orderRef}/confirm`)).send({});
    await as(mgr).set(request(app).post(`/api/orders/${o.orderRef}/dispatch`)).send({ courierId: org.id, packageFee: { amountCents: 25_000 } });
    const col = await as(mgr).set(request(app).post(`/api/couriers/${org.id}/collections`)).send({ orderRef: o.orderRef, amountCents: 200_000 });
    expect(col.status).toBe(201);
    await as(mgr).set(request(app).post(`/api/orders/${o.orderRef}/attempts`)).send({ outcome: 'delivered' });
    const open = await as(mgr).set(request(app).get(`/api/couriers/${org.id}/open-collections`));
    expect(open.body.collections).toHaveLength(1);
    const detail = await as(mgr).set(request(app).get(`/api/couriers/${org.id}`));
    expect(detail.body.standing.outstandingCents).toBe(200_000);

    const st = await as(mgr).set(request(app).post(`/api/couriers/${org.id}/statements`)).send({
      periodStart: '2026-10-01', periodEnd: '2026-10-31', collectionIds: [open.body.collections[0].id], chargeEnteredCents: 25_000, remittedCents: 175_000, remittanceRef: 'BANK-1' });
    expect(st.status).toBe(201);
    expect(st.body.statement).toMatchObject({ collectionsCents: 200_000, feesCents: 25_000, remittedCents: 175_000, cashVarianceCents: 0 });
    expect((await as(mgr).set(request(app).get(`/api/couriers/${org.id}/open-collections`))).body.collections).toHaveLength(0);

    const cost = await as(mgr).set(request(app).post(`/api/couriers/${org.id}/costs`)).send({ kind: 'fuel', amountCents: 5_000, description: 'Fuel for returns' });
    expect(cost.body.cost.status).toBe('pending');
    expect((await as(mgr).set(request(app).get('/api/couriers/costs?status=pending'))).body.total).toBeGreaterThanOrEqual(1);
    const rej = await as(mgr).set(request(app).post(`/api/couriers/costs/${cost.body.cost.id}/reject`)).send({});
    expect(rej.status).toBe(422);
    // whoever entered a cost cannot also approve it
    expect((await as(mgr).set(request(app).post(`/api/couriers/costs/${cost.body.cost.id}/approve`))).status).toBe(403);
    const boss = await loggedIn(db.pool, 'admin');
    expect((await as(boss).set(request(app).post(`/api/couriers/costs/${cost.body.cost.id}/approve`))).body.cost.status).toBe('approved');
    expect((await runIntegrityChecks(db.pool)).violations).toEqual([]);
  });
});

describe('payroll: rates, attendance, salary pages and a run', () => {
  it('lets an admin set pay, staff clock themselves in, and each person see only their own pay', async () => {
    const admin = await loggedIn(db.pool, 'admin');
    const mgr = await loggedIn(db.pool, 'manager');
    const staff = await loggedIn(db.pool, 'cashier');
    const other = await loggedIn(db.pool, 'cashier');
    const today = shopDate(new Date());
    const month = { from: today.slice(0, 8) + '01', to: today };

    const plan = await as(admin).set(request(app).post('/api/payroll/plans')).send({ name: 'Standard', targetCents: 10_000_000, rateBelow70Cents: 0, rate70Cents: 5_000, rate80Cents: 10_000 });
    expect(plan.status).toBe(201);
    expect((await as(mgr).set(request(app).post('/api/payroll/plans')).send({ name: 'Mine', targetCents: 1, rateBelow70Cents: 0, rate70Cents: 0, rate80Cents: 0 })).status).toBe(403);
    expect((await as(mgr).set(request(app).get('/api/payroll/plans'))).body.plans).toHaveLength(1);
    const prof = await as(admin).set(request(app).post('/api/payroll/profiles')).send({ staffKey: staff.username, effectiveFrom: month.from, dailyRetainerCents: 100_000, commissionPlanId: plan.body.plan.id, workdayStartMinute: 0, expectedMinutes: 1 });
    expect(prof.status).toBe(201);
    expect((await as(mgr).set(request(app).post('/api/payroll/profiles')).send({ staffKey: staff.username, effectiveFrom: month.from, dailyRetainerCents: 1 })).status).toBe(403);
    expect((await as(mgr).set(request(app).get('/api/payroll/profiles'))).body.profiles.map((p: { staffKey: string }) => p.staffKey)).toContain(staff.username);

    expect((await as(staff).set(request(app).post('/api/payroll/attendance/clock-in'))).status).toBe(201);
    expect((await as(staff).set(request(app).post('/api/payroll/attendance/clock-in'))).status).toBe(409);
    expect((await as(staff).set(request(app).post('/api/payroll/attendance/clock-out'))).status).toBe(200);
    expect((await as(staff).set(request(app).get(`/api/payroll/attendance?from=${month.from}&to=${month.to}`))).body.records).toHaveLength(1);
    expect((await as(other).set(request(app).get(`/api/payroll/attendance?staffKey=${staff.username}&from=${month.from}&to=${month.to}`))).status).toBe(403);
    expect((await as(mgr).set(request(app).get(`/api/payroll/attendance?staffKey=${staff.username}&from=${month.from}&to=${month.to}`))).status).toBe(200);

    const adj = await as(mgr).set(request(app).post('/api/payroll/adjustments')).send({ staffKey: staff.username, type: 'salary_advance', amountCents: 20_000, effectiveDate: today, reason: 'Emergency' });
    expect(adj.status).toBe(201);

    const table = await as(mgr).set(request(app).get(`/api/payroll/salary?from=${month.from}&to=${month.to}`));
    expect(table.body.source).toBe('live');
    const row = table.body.rows.find((r: { staffKey: string }) => r.staffKey === staff.username);
    expect(row).toMatchObject({ daysWorked: 1, retainerCents: 100_000, advancesCents: 20_000 });
    expect((await as(staff).set(request(app).get(`/api/payroll/salary?from=${month.from}&to=${month.to}`))).status).toBe(403);
    const mine = await as(staff).set(request(app).get(`/api/payroll/staff/${staff.username}?from=${month.from}&to=${month.to}`));
    expect(mine.body.item.netCents).toBe(row.netCents);
    expect((await as(other).set(request(app).get(`/api/payroll/staff/${staff.username}?from=${month.from}&to=${month.to}`))).status).toBe(403);
    expect((await as(staff).set(request(app).get('/api/payroll/salary?from=2026-13-01&to=2026-10-01'))).status).toBe(403);
    expect((await as(mgr).set(request(app).get('/api/payroll/salary?from=2026-10-31&to=2026-10-01'))).status).toBe(422);

    // run: draft, approve (admin), pay (admin), payslip and csv
    const run = await as(mgr).set(request(app).post('/api/payroll/runs')).send(month);
    const id = run.body.run.id;
    await as(admin).set(request(app).post(`/api/payroll/runs/${id}/approve`));
    expect((await as(mgr).set(request(app).get(`/api/payroll/runs/${id}/export.csv`))).text).toContain(staff.username);
    expect((await as(staff).set(request(app).get(`/api/payroll/runs/${id}/payslips/${staff.username}`))).body.payslip.item.staffKey).toBe(staff.username);
    expect((await as(other).set(request(app).get(`/api/payroll/runs/${id}/payslips/${staff.username}`))).status).toBe(403);
    expect((await as(staff).set(request(app).get(`/api/payroll/runs/${id}/payslips/${staff.username}?format=text`))).text).toContain(staff.username);
    // once the run is locked, an advance dated inside it is refused
    expect((await as(mgr).set(request(app).post('/api/payroll/adjustments')).send({ staffKey: staff.username, type: 'bonus', amountCents: 1_000, effectiveDate: today, reason: 'Late' })).status).toBeGreaterThanOrEqual(400);
    expect((await runIntegrityChecks(db.pool)).violations).toEqual([]);
  });
});

describe('policy and integrity endpoints', () => {
  it('lets an admin add a discount reason and a new limit, and run the integrity check now', async () => {
    const admin = await loggedIn(db.pool, 'admin');
    const mgr = await loggedIn(db.pool, 'manager');
    expect((await as(admin).set(request(app).post('/api/discount-reasons')).send({ code: 'staff_friend', label: 'Staff friend' })).status).toBe(201);
    expect((await as(mgr).set(request(app).get('/api/discount-reasons'))).body.reasons.map((r: { code: string }) => r.code)).toContain('staff_friend');
    expect((await as(admin).set(request(app).put('/api/discount-reasons/staff_friend/active')).send({ active: false })).status).toBe(200);
    expect((await as(admin).set(request(app).put('/api/discount-policies')).send({ role: 'cashier', freeLimitBp: 500, approveCeilingBp: 500, effectiveFrom: '2099-01-01' })).status).toBe(201);
    const pol = (await as(mgr).set(request(app).get('/api/discount-policies'))).body.policies;
    expect(pol.some((p: { effectiveFrom: string; inForce: boolean }) => p.effectiveFrom === '2099-01-01' && !p.inForce)).toBe(true);
    const run = await as(admin).set(request(app).post('/api/integrity/run'));
    expect(run.body.ran).toBe(true);
    expect(run.body.report.ok).toBe(true);
    expect((await as(mgr).set(request(app).get('/api/integrity'))).body.runs[0]).toMatchObject({ ok: true, violationCount: 0 });
  });
});
