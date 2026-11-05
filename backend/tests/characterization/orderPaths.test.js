const { request, app, db, auth, admin, newProduct, cached, mark, movementsSince, expectLedgerBalanced } = require('./helpers');
const { cleanupTestDb } = require('../setup');
const reconciliation = require('../../src/services/reconciliation.service');

afterAll(() => cleanupTestDb());

let A; let rider; let seq = 0;
const FEE = 30000;
beforeAll(async () => {
  A = await admin();
  rider = (await request(app).post('/api/couriers').set(auth(A.token)).send({ name: 'Char Rider', courier_type: 'boda' })).body.data;
});

async function makeOrder(pid, qty, extra = {}) {
  seq += 1;
  const res = await request(app).post('/api/orders').set(auth(A.token)).send({
    name: 'Char Customer', phone: `07990${String(10000 + seq)}`, city: 'Nairobi', payment_type: 'prepaid',
    items: [{ product_id: pid, quantity: qty }], ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.data;
}
const dispatch = (id, body = { delivery_fee_paid: false }) => request(app).post(`/api/orders/${id}/dispatch`).set(auth(A.token)).send(body);
const status = (id) => db.prepare('SELECT status, amount_paid, total FROM orders WHERE id = ?').get(id);

describe('R0 characterization: online / COD orders and stock', () => {
  it('creating an order moves no stock; dispatch deducts once with a "dispatch" row', async () => {
    const pid = newProduct({ sell: 1000, stock: 10 });
    const m0 = mark();
    const o = await makeOrder(pid, 3);
    expect(o.status).toBe('awaiting_dispatch');
    expect(movementsSince(m0, pid)).toEqual([]);
    expect(cached(pid)).toBe(10);

    const m = mark();
    expect((await dispatch(o.id)).status).toBe(200);
    expect(movementsSince(m, pid)).toEqual([{ store_id: A.mainId, change: -3, reason: 'dispatch', ref: 'order' }]);
    expect(cached(pid)).toBe(7);
    expect((await dispatch(o.id)).status).toBeGreaterThanOrEqual(400);
    expect(cached(pid)).toBe(7);
    expectLedgerBalanced(pid);
  });

  it('cancelling before dispatch moves no stock', async () => {
    const pid = newProduct({ stock: 5 });
    const o = await makeOrder(pid, 2);
    const m = mark();
    expect((await request(app).post(`/api/orders/${o.id}/cancel`).set(auth(A.token)).send({})).status).toBe(200);
    expect(movementsSince(m, pid)).toEqual([]);
    expect(cached(pid)).toBe(5);
    expect(status(o.id).status).toBe('cancelled');
  });

  it('dispatch refused for lack of stock changes nothing', async () => {
    const pid = newProduct({ stock: 1 });
    const o = await makeOrder(pid, 4);
    const m = mark();
    expect((await dispatch(o.id)).status).toBe(409);
    expect(movementsSince(m, pid)).toEqual([]);
    expect(status(o.id).status).toBe('awaiting_dispatch');
    expect(cached(pid)).toBe(1);
  });

  it('return inspected good puts stock back with a "return_resellable" row', async () => {
    const pid = newProduct({ stock: 10 });
    const o = await makeOrder(pid, 2);
    await dispatch(o.id);
    await request(app).post(`/api/orders/${o.id}/returned-in-transit`).set(auth(A.token)).send({});
    await request(app).post(`/api/orders/${o.id}/returned-awaiting-inspection`).set(auth(A.token)).send({});
    const m = mark();
    expect((await request(app).post(`/api/orders/${o.id}/inspect`).set(auth(A.token)).send({ result: 'good' })).status).toBe(200);
    expect(movementsSince(m, pid)).toEqual([{ store_id: A.mainId, change: 2, reason: 'return_resellable', ref: 'order' }]);
    expect(cached(pid)).toBe(10);
    expectLedgerBalanced(pid);
  });

  it('return inspected damaged does NOT put stock back', async () => {
    const pid = newProduct({ stock: 10 });
    const o = await makeOrder(pid, 2);
    await dispatch(o.id);
    await request(app).post(`/api/orders/${o.id}/returned-in-transit`).set(auth(A.token)).send({});
    await request(app).post(`/api/orders/${o.id}/returned-awaiting-inspection`).set(auth(A.token)).send({});
    const m = mark();
    expect((await request(app).post(`/api/orders/${o.id}/inspect`).set(auth(A.token)).send({ result: 'damaged' })).status).toBe(200);
    expect(movementsSince(m, pid)).toEqual([]);
    expect(cached(pid)).toBe(8);
    expectLedgerBalanced(pid);
  });
});

describe('R0 characterization: order payments and refunds', () => {
  const pay = (id, amount) => request(app).post(`/api/orders/${id}/payments`).set(auth(A.token))
    .send({ method: 'mobile_money', amount, reference: `CH${Date.now()}${Math.random()}` });
  const paymentIds = (id) => db.prepare('SELECT id FROM payment_records WHERE order_id = ? ORDER BY id').all(id).map((r) => r.id);

  it('part payments add up to the order total and flip the status exactly at the total', async () => {
    const pid = newProduct({ sell: 5000, stock: 20 });
    const o = await makeOrder(pid, 2);
    await dispatch(o.id);
    expect(status(o.id)).toMatchObject({ status: 'dispatched_unpaid', amount_paid: 0, total: 10000 });
    expect((await pay(o.id, 4000)).status).toBe(201);
    expect(status(o.id)).toMatchObject({ status: 'dispatched_partial', amount_paid: 4000 });
    expect((await pay(o.id, 6000)).status).toBe(201);
    expect(status(o.id)).toMatchObject({ status: 'dispatched_paid', amount_paid: 10000 });
  });

  it('refunding a payment takes exactly that amount back off the order, once', async () => {
    const pid = newProduct({ sell: 5000, stock: 20 });
    const o = await makeOrder(pid, 2);
    await dispatch(o.id);
    await pay(o.id, 4000); await pay(o.id, 6000);
    const [first, second] = paymentIds(o.id);
    expect((await request(app).post(`/api/payments/${second}/refund`).set(auth(A.token))).status).toBe(200);
    expect(status(o.id)).toMatchObject({ status: 'dispatched_partial', amount_paid: 4000 });
    expect((await request(app).post(`/api/payments/${second}/refund`).set(auth(A.token))).status).toBe(409);
    expect(status(o.id).amount_paid).toBe(4000);
    expect((await request(app).post(`/api/payments/${first}/refund`).set(auth(A.token))).status).toBe(200);
    expect(status(o.id)).toMatchObject({ status: 'dispatched_unpaid', amount_paid: 0 });
  });

  it('a payment and its order never disagree: amount_paid equals the sum of live payment records', async () => {
    const pid = newProduct({ sell: 3000, stock: 20 });
    const o = await makeOrder(pid, 3);
    await dispatch(o.id);
    await pay(o.id, 2500); await pay(o.id, 1500);
    const sum = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS s FROM payment_records WHERE order_id = ? AND status != 'refunded'`).get(o.id);
    expect(status(o.id).amount_paid).toBe(sum.s);
  });
});

describe('R0 characterization: courier delivery settlement', () => {
  async function settledOrder(dispatchBody, costs = []) {
    const pid = newProduct({ sell: 1000, stock: 10 });
    const o = await makeOrder(pid, 1);
    db.prepare('UPDATE orders SET delivery_fee = ? WHERE id = ?').run(FEE, o.id);
    await request(app).post(`/api/orders/${o.id}/courier`).set(auth(A.token)).send({ courier_id: rider.id });
    expect((await dispatch(o.id, dispatchBody)).status).toBe(200);
    for (const amount of costs) {
      const c = await request(app).post(`/api/orders/${o.id}/delivery/costs`).set(auth(A.token))
        .send({ kind: 'outpost_leg', amount, reason: 'Outpost leg', paid_via: 'mobile_money' });
      expect(c.status).toBe(201);
      expect((await request(app).post(`/api/delivery/costs/${c.body.data.id}/approve`).set(auth(A.token))).status).toBe(200);
    }
    for (const r of db.prepare('SELECT id FROM delivery_fee_receipts WHERE order_id = ?').all(o.id)) {
      await request(app).post(`/api/delivery/fee-receipts/${r.id}/verify`).set(auth(A.token)).send({ note: 'seen' });
    }
    return o;
  }
  const close = (id, body = {}) => request(app).post(`/api/orders/${id}/delivery/close`).set(auth(A.token)).send(body);

  it('delivered, fee collected in full, two costs: result = fee collected minus all costs', async () => {
    const o = await settledOrder({ package_fee: 10000, delivery_fee_paid: true, delivery_fee_collected: FEE, delivery_fee_method: 'cash' }, [5000]);
    const closed = await close(o.id, { note: 'confirmed' });
    expect(closed.status).toBe(200);
    expect(closed.body.data.settlement).toMatchObject({ status: 'closed', outcome: 'delivered', fee_collected: FEE, costs_total: 15000, result: FEE - 15000 });
  });

  it('returned parcel, fee never paid: the shop carries the package fee as a loss', async () => {
    const pid = newProduct({ sell: 1000, stock: 10 });
    const o = await makeOrder(pid, 1);
    db.prepare('UPDATE orders SET delivery_fee = ? WHERE id = ?').run(FEE, o.id);
    await request(app).post(`/api/orders/${o.id}/courier`).set(auth(A.token)).send({ courier_id: rider.id });
    await dispatch(o.id, { package_fee: 10000, delivery_fee_paid: false });
    await request(app).post(`/api/orders/${o.id}/returned-in-transit`).set(auth(A.token)).send({});
    await request(app).post(`/api/orders/${o.id}/returned-awaiting-inspection`).set(auth(A.token)).send({});
    const closed = await close(o.id, { write_off_reason: 'Parcel came back; fee never paid' });
    expect(closed.status).toBe(200);
    expect(closed.body.data.settlement).toMatchObject({ outcome: 'returned', result: -10000 });
  });

  it('a closed settlement is frozen: no new costs or fee receipts', async () => {
    const o = await settledOrder({ delivery_fee_paid: false });
    expect((await close(o.id, { write_off_reason: 'Customer refused to pay the fee' })).status).toBe(200);
    const late = await request(app).post(`/api/orders/${o.id}/delivery/costs`).set(auth(A.token))
      .send({ kind: 'outpost_leg', amount: 100, reason: 'late', paid_via: 'cash' });
    expect(late.status).toBe(409);
    const receipt = await request(app).post(`/api/orders/${o.id}/delivery/fee-receipts`).set(auth(A.token)).send({ amount: 100, method: 'cash' });
    expect(receipt.status).toBe(409);
  });
});

describe('R1 guarantee: orders leave no drift', () => {
  it('after dispatches, returns and settlements, cache and ledger agree across the whole database', () => {
    expect(reconciliation.findDrift()).toEqual([]);
  });
});
