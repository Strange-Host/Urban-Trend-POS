import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';
import { loggedIn } from './authHelpers.js';
import { makeTestDb, type TestDb } from './helpers.js';
import { KEY } from './orderHelpers.js';

let db: TestDb;
let app: ReturnType<typeof createApp>;
beforeAll(async () => { db = await makeTestDb(); await runMigrations(db.pool); app = createApp({ pool: db.pool, logger: createLogger('silent'), orderRefKey: KEY }); });
afterAll(() => db.drop());

const as = (u: { auth: string }) => ({ set: (r: request.Test) => r.set('Authorization', u.auth) });
let phone = 0;
const fresh = () => `0744${String(100000 + phone++)}`;

async function setup() {
  const agent = await loggedIn(db.pool, 'cashier');
  const mgr = await loggedIn(db.pool, 'manager');
  const rider = (await as(mgr).set(request(app).post('/api/couriers/riders')).send({ name: `Rider ${phone}`, phone: '0700123456' })).body.courier;
  const make = async (cents = 500_000, quantity = 1) => (await as(agent).set(request(app).post('/api/orders')).send({ customerName: 'Wanjiku', customerPhone: fresh(), items: [{ name: 'Sneakers', quantity, unitPriceCents: cents }] })).body.order.orderRef as string;
  const dispatch = (ref: string) => as(mgr).set(request(app).post(`/api/orders/${ref}/dispatch`)).send({ courierId: rider.id, packageFee: { amountCents: 30_000 } });
  return { agent, mgr, rider, make, dispatch };
}

describe('confirming an order with the customer before it leaves the shop', () => {
  it('refuses to dispatch an unpaid, unconfirmed order, and allows it once confirmed', async () => {
    const { mgr, make, dispatch } = await setup();
    const ref = await make();
    const blocked = await dispatch(ref);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('ORDER_NOT_CONFIRMED');
    const ok = await as(mgr).set(request(app).post(`/api/orders/${ref}/confirm`)).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.order.confirmedAt).toBeTruthy();
    expect(ok.body.order.confirmedBy).toBe(mgr.username);
    expect((await dispatch(ref)).status).toBe(200);
  });

  it('is a manager\'s action, can be repeated harmlessly, and is kept as an event', async () => {
    const { agent, mgr, make } = await setup();
    const ref = await make();
    expect((await as(agent).set(request(app).post(`/api/orders/${ref}/confirm`)).send({})).status).toBe(403);
    await as(mgr).set(request(app).post(`/api/orders/${ref}/confirm`)).send({});
    const again = await as(mgr).set(request(app).post(`/api/orders/${ref}/confirm`)).send({});
    expect(again.status).toBe(200);
    expect(again.body.order.events.filter((e: { type: string }) => e.type === 'confirmed')).toHaveLength(1);
    expect((await as(mgr).set(request(app).get(`/api/orders/${ref}`)).send()).body.order.confirmedBy).toBe(mgr.username);
  });

  it('only applies to an order still waiting to be dispatched, and an unknown one is a 404', async () => {
    const { mgr, make, dispatch } = await setup();
    const ref = await make();
    await as(mgr).set(request(app).post(`/api/orders/${ref}/confirm`)).send({});
    await dispatch(ref);
    expect((await as(mgr).set(request(app).post(`/api/orders/${ref}/confirm`)).send({})).status).toBe(409);
    expect((await as(mgr).set(request(app).post('/api/orders/UT-NOSUCH00/confirm')).send({})).status).toBe(404);
  });

  it('does not ask for a call when money is already in: a paid order needs no confirmation', async () => {
    const { mgr, make, dispatch } = await setup();
    const ref = await make(300_000);
    expect((await as(mgr).set(request(app).post(`/api/orders/${ref}/shop-cash`)).send({ amountCents: 300_000, reason: 'Paid at the counter' })).status).toBe(201);
    expect((await dispatch(ref)).status).toBe(200);
  });

  it('checks confirmation first, and only then the rest of the dispatch (a missing fee is reported once confirmed)', async () => {
    const { mgr, rider, make } = await setup();
    const ref = await make();
    const unconfirmed = await as(mgr).set(request(app).post(`/api/orders/${ref}/dispatch`)).send({ courierId: rider.id });
    expect(unconfirmed.body.error.code).toBe('ORDER_NOT_CONFIRMED');
    await as(mgr).set(request(app).post(`/api/orders/${ref}/confirm`)).send({});
    expect((await as(mgr).set(request(app).post(`/api/orders/${ref}/dispatch`)).send({ courierId: rider.id })).status).toBe(422);
  });
});

describe('the order list the Orders screen reads', () => {
  it('carries what is paid, the payment state and when it was confirmed, and filters by payment state', async () => {
    const { mgr, make, dispatch } = await setup();
    const unpaid = await make(100_000);
    const part = await make(200_000);
    const full = await make(300_000);
    for (const [ref, cents] of [[part, 50_000], [full, 300_000]] as const) {
      await as(mgr).set(request(app).post(`/api/orders/${ref}/shop-cash`)).send({ amountCents: cents, reason: 'Paid at the counter' });
    }
    await as(mgr).set(request(app).post(`/api/orders/${unpaid}/confirm`)).send({});
    const all = (await as(mgr).set(request(app).get('/api/orders?limit=50')).send()).body;
    const by = (ref: string) => all.orders.find((o: { orderRef: string }) => o.orderRef === ref);
    expect(by(unpaid)).toMatchObject({ paidCents: 0, paymentStatus: 'unpaid', balanceCents: 100_000 });
    expect(by(unpaid).confirmedAt).toBeTruthy();
    expect(by(part)).toMatchObject({ paidCents: 50_000, paymentStatus: 'part_paid', balanceCents: 150_000 });
    expect(by(full)).toMatchObject({ paidCents: 300_000, paymentStatus: 'paid', balanceCents: 0 });
    expect(by(part).confirmedAt).toBeNull();

    const only = async (s: string) => (await as(mgr).set(request(app).get(`/api/orders?limit=50&paymentStatus=${s}`)).send()).body.orders.map((o: { orderRef: string }) => o.orderRef);
    expect(await only('unpaid')).toContain(unpaid);
    expect(await only('unpaid')).not.toContain(part);
    expect(await only('part_paid')).toContain(part);
    expect(await only('part_paid')).not.toContain(full);
    expect(await only('paid')).toContain(full);
    expect(await only('paid')).not.toContain(part);
    expect((await as(mgr).set(request(app).get('/api/orders?paymentStatus=nonsense')).send()).status).toBe(200); // an unknown value is ignored, not an error

    // the Orders header: what parcels that have left the shop are still owed
    const before = (await as(mgr).set(request(app).get('/api/orders?limit=1')).send()).body.summary.outstandingCents;
    await dispatch(part);
    const after = (await as(mgr).set(request(app).get('/api/orders?limit=1')).send()).body.summary.outstandingCents;
    expect(after - before).toBe(150_000); // only the dispatched order's balance; orders still waiting are not "outstanding"
  });
});

describe('returned parcels in the order list and on the order', () => {
  async function returnedOrder(restock: number, damaged: number) {
    const { mgr, rider, make } = await setup();
    const ref = await make(100_000, 2); // two pairs, KES 2,000 in all
    const call = (path: string, body: object) => as(mgr).set(request(app).post(`/api/orders/${ref}/${path}`)).send(body);
    await call('confirm', {});
    await call('dispatch', { courierId: rider.id, packageFee: { amountCents: 20_000 } });
    await call('attempts', { outcome: 'refused', reason: 'Customer rejected the parcel' });
    const item = (await as(mgr).set(request(app).get(`/api/orders/${ref}`)).send()).body.order.items[0];
    const res = await call('returned', { items: [{ orderItemId: item.id, restockQuantity: restock, damagedQuantity: damaged }], notes: 'counted' });
    expect(res.status).toBe(200);
    return { mgr, ref };
  }

  it('lists by several statuses at once, ignoring unknown ones', async () => {
    const { mgr, make, dispatch } = await setup();
    const waiting = await make();
    const sent = await make();
    await as(mgr).set(request(app).post(`/api/orders/${sent}/confirm`)).send({});
    await dispatch(sent);
    const refs = async (q: string) => (await as(mgr).set(request(app).get(`/api/orders?limit=100&${q}`)).send()).body.orders.map((o: { orderRef: string }) => o.orderRef);
    const both = await refs('status=awaiting_dispatch,dispatched');
    expect(both).toContain(waiting);
    expect(both).toContain(sent);
    const onlySent = await refs('status=dispatched,delivered,nonsense');
    expect(onlySent).toContain(sent);
    expect(onlySent).not.toContain(waiting);
  });

  it('tells a clean return from one with damaged goods, in the list and on the order', async () => {
    const clean = await returnedOrder(2, 0);
    const scuffed = await returnedOrder(1, 1);
    const refs = async (q: string) => (await as(clean.mgr).set(request(app).get(`/api/orders?limit=100&status=returned&${q}`)).send()).body.orders.map((o: { orderRef: string }) => o.orderRef);
    expect(await refs('returnProblem=true')).toContain(scuffed.ref);
    expect(await refs('returnProblem=true')).not.toContain(clean.ref);
    expect(await refs('returnProblem=false')).toContain(clean.ref);
    expect(await refs('returnProblem=false')).not.toContain(scuffed.ref);
    const all = (await as(clean.mgr).set(request(app).get('/api/orders?limit=100&status=returned')).send()).body.orders;
    expect(all.find((o: { orderRef: string }) => o.orderRef === scuffed.ref).returnProblem).toBe(true);

    const detail = (await as(clean.mgr).set(request(app).get(`/api/orders/${scuffed.ref}`)).send()).body.order;
    expect(detail.returned).toMatchObject({ restocked: 1, damaged: 1, missing: 0, receivedBy: scuffed.mgr.username, notes: 'counted' });
    expect(detail.returned.unpaidWrittenOffCents).toBe(200_000); // nothing was paid, so the whole order came off sales
    const waiting = (await as(clean.mgr).set(request(app).get(`/api/orders/${clean.ref}`)).send()).body.order;
    expect(waiting.returned.damaged).toBe(0);
  });

  it('counts goods that did not come back as a problem too, and has no return summary before the parcel is counted in', async () => {
    const { mgr, rider, make } = await setup();
    const ref = await make(300_000);
    const call = (path: string, body: object) => as(mgr).set(request(app).post(`/api/orders/${ref}/${path}`)).send(body);
    await call('confirm', {});
    await call('dispatch', { courierId: rider.id, packageFee: { amountCents: 20_000 } });
    await call('attempts', { outcome: 'not_claimed', reason: 'Nobody collected it' });
    expect((await as(mgr).set(request(app).get(`/api/orders/${ref}`)).send()).body.order.returned).toBeNull();
    const item = (await as(mgr).set(request(app).get(`/api/orders/${ref}`)).send()).body.order.items[0];
    await call('returned', { items: [{ orderItemId: item.id, restockQuantity: 0, damagedQuantity: 0 }], notes: 'Parcel came back empty' });
    const list = (await as(mgr).set(request(app).get('/api/orders?limit=100&status=returned&returnProblem=true')).send()).body.orders;
    expect(list.map((o: { orderRef: string }) => o.orderRef)).toContain(ref);
  });
});
