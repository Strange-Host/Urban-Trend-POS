const H = require('./mobileHelpers');
const { cleanupTestDb } = require('./setup');
const { app, request, auth } = H;
const db = require('../src/config/db');

let webToken; let manager; let cashier; let seq = 0;
beforeAll(async () => {
  webToken = await H.loginAsAdmin();
  manager = await H.makeUser('manager', 'pay-mgr');
  cashier = await H.makeUser('cashier', 'pay-cashier');
});
afterAll(() => cleanupTestDb());

const web = (r) => r.set('Authorization', `Bearer ${webToken}`);

// A dispatched, unpaid order for a known amount and customer.
async function dispatchedOrder({ price = 200000, name = 'Pat Customer', phone } = {}) {
  seq += 1;
  const p = H.makeProduct({ sell: price });
  db.prepare('UPDATE inventory SET quantity = 100 WHERE product_id = ? AND store_id = ?').run(p.id, H.storeId());
  const created = await web(request(app).post('/api/orders')).send({ name, phone: phone || `0766${String(seq).padStart(6, '0')}`, payment_type: 'prepaid', items: [{ product_id: p.id, quantity: 1 }] });
  expect(created.status).toBe(201);
  const d = await web(request(app).post(`/api/orders/${created.body.data.id}/dispatch`)).send({ delivery_fee_paid: false });
  expect(d.status).toBe(200);
  return created.body.data;
}
function payment({ amount, payer = 'Someone Else', ref, matchedCode = null, raw = null } = {}) {
  seq += 1;
  return Number(db.prepare(`
    INSERT INTO payment_notifications (store_id, source, method, amount, direction, external_reference, matched_code, payer_name, status, raw_payload)
    VALUES (?, 'mpesa', 'mobile_money', ?, 'incoming', ?, ?, ?, 'unmatched', ?)
  `).run(H.storeId(), amount, ref || `QX${Date.now()}${seq}`, matchedCode, payer, raw ? JSON.stringify(raw) : null).lastInsertRowid);
}
const orderRow = (id) => db.prepare('SELECT status, amount_paid, total FROM orders WHERE id = ?').get(id);
const paymentRecords = (orderId) => db.prepare(`SELECT * FROM payment_records WHERE order_id = ?`).all(orderId);

describe('permission', () => {
  it('a cashier cannot see or touch payments', async () => {
    const id = payment({ amount: 1000 });
    expect((await request(app).get('/api/v1/payments/unmatched').set(auth(cashier))).status).toBe(403);
    expect((await request(app).get(`/api/v1/payments/${id}/suggestions`).set(auth(cashier))).status).toBe(403);
    expect((await request(app).post(`/api/v1/payments/${id}/match`).set(auth(cashier)).send({ orderId: 1 })).status).toBe(403);
    expect((await request(app).post(`/api/v1/payments/${id}/ignore`).set(auth(cashier)).send({ reason: 'nope nope' })).status).toBe(403);
    expect((await request(app).get('/api/v1/payments/unmatched')).status).toBe(401);
  });
});

describe('list', () => {
  it('lists oldest first with the total waiting, and pages', async () => {
    const ids = [payment({ amount: 111100 }), payment({ amount: 222200 }), payment({ amount: 333300 })];
    const all = await request(app).get('/api/v1/payments/unmatched?limit=100').set(auth(manager));
    expect(all.status).toBe(200);
    expect(all.body.total).toBeGreaterThanOrEqual(3);
    expect(all.body.unallocatedCents).toBeGreaterThanOrEqual(666600);
    const mine = all.body.items.filter((i) => ids.includes(i.id)).map((i) => i.id);
    expect(mine).toEqual(ids);                                  // oldest (lowest id) first
    expect(all.body.items[0]).toMatchObject({ source: 'mpesa', method: 'mobile_money', ageMinutes: expect.any(Number) });
    const seen = []; let cursor = null; let guard = 0;
    do {
      const r = await request(app).get(`/api/v1/payments/unmatched?limit=2${cursor ? `&cursor=${cursor}` : ''}`).set(auth(manager));
      seen.push(...r.body.items.map((i) => i.id)); cursor = r.body.nextCursor; guard += 1;
    } while (cursor && guard < 50);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(all.body.total);
  });
});

describe('suggestions', () => {
  it('ranks the order whose balance equals the payment first, and explains why', async () => {
    const exact = await dispatchedOrder({ price: 345600, name: 'Grace Wanjiru' });
    await dispatchedOrder({ price: 987600, name: 'Other Person' });
    const id = payment({ amount: exact.total, payer: 'Grace W' });
    const r = await request(app).get(`/api/v1/payments/${id}/suggestions`).set(auth(manager));
    expect(r.status).toBe(200);
    expect(r.body.items[0]).toMatchObject({ orderId: exact.id, balanceCents: exact.total, customerName: 'Grace Wanjiru' });
    expect(r.body.items[0].reasons).toEqual(expect.arrayContaining(['amount']));
    expect(r.body.items.length).toBeLessThanOrEqual(5);
  });
  it('uses the phone number and the product code when the payment carries them', async () => {
    const o = await dispatchedOrder({ price: 150000, phone: '0722123456', name: 'Phone Match' });
    const byPhone = payment({ amount: 5000, payer: 'X', raw: { msisdn: '254722123456' } });
    const r1 = await request(app).get(`/api/v1/payments/${byPhone}/suggestions`).set(auth(manager));
    expect(r1.body.items[0]).toMatchObject({ orderId: o.id });
    expect(r1.body.items[0].reasons).toContain('phone');
    const byCode = payment({ amount: 7000, payer: 'Y', matchedCode: o.product_code });
    const r2 = await request(app).get(`/api/v1/payments/${byCode}/suggestions`).set(auth(manager));
    expect(r2.body.items[0].orderId).toBe(o.id);
    expect(r2.body.items[0].reasons).toContain('code');
  });
  it('can be searched by hand, and never offers an order that cannot take a payment', async () => {
    const paid = await dispatchedOrder({ price: 100000, name: 'Already Paid Pat' });
    const id = payment({ amount: paid.total });
    // pay it in full through the web, so it is no longer payable
    await web(request(app).post(`/api/orders/${paid.id}/payments`)).send({ method: 'cash', amount: paid.total });
    const r = await request(app).get(`/api/v1/payments/${id}/suggestions?q=Already%20Paid`).set(auth(manager));
    expect(r.body.items.find((i) => i.orderId === paid.id)).toBeUndefined();
    expect((await request(app).get('/api/v1/payments/999999/suggestions').set(auth(manager))).status).toBe(404);
  });
});

describe('matching', () => {
  it('counts the money once: one payment record, order paid, and a second match is refused', async () => {
    const o = await dispatchedOrder({ price: 250000 });
    const id = payment({ amount: o.total });
    const first = await request(app).post(`/api/v1/payments/${id}/match`).set(auth(manager)).send({ orderId: o.id });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ payment: { id, status: 'matched' }, order: { id: o.id, paymentState: 'paid', balanceCents: 0 } });
    expect(orderRow(o.id)).toMatchObject({ status: 'dispatched_paid', amount_paid: o.total });
    expect(paymentRecords(o.id)).toHaveLength(1);

    const again = await request(app).post(`/api/v1/payments/${id}/match`).set(auth(manager)).send({ orderId: o.id });
    expect(again.status).toBe(409); expect(again.body.error.code).toBe('ALREADY_MATCHED');
    const other = await dispatchedOrder({ price: o.total });
    const elsewhere = await request(app).post(`/api/v1/payments/${id}/match`).set(auth(manager)).send({ orderId: other.id });
    expect(elsewhere.body.error.code).toBe('ALREADY_MATCHED');
    expect(orderRow(other.id).amount_paid).toBe(0);
    expect(paymentRecords(o.id)).toHaveLength(1);
    expect(orderRow(o.id).amount_paid).toBe(o.total);           // not doubled
    expect(db.prepare('SELECT status, order_id, resolved_by FROM payment_notifications WHERE id = ?').get(id)).toMatchObject({ status: 'matched', order_id: o.id, resolved_by: manager.id });
    const log = H.lastLog('payment_notification', id);
    expect(log.staff_id).toBe(manager.id); expect(log.changes.deviceId.to).toBe(manager.sessionId);
  });

  it('two taps at once: exactly one wins', async () => {
    const o = await dispatchedOrder({ price: 120000 });
    const id = payment({ amount: o.total });
    const results = await Promise.all([1, 2].map(() => request(app).post(`/api/v1/payments/${id}/match`).set(auth(manager)).send({ orderId: o.id })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(paymentRecords(o.id)).toHaveLength(1);
  });

  it('refuses a payment bigger than the balance, and changes nothing', async () => {
    const o = await dispatchedOrder({ price: 100000 });
    const id = payment({ amount: o.total + 1 });
    const r = await request(app).post(`/api/v1/payments/${id}/match`).set(auth(manager)).send({ orderId: o.id });
    expect(r.status).toBe(422); expect(r.body.error.code).toBe('AMOUNT_EXCEEDS_BALANCE');
    expect(orderRow(o.id).amount_paid).toBe(0);
    expect(paymentRecords(o.id)).toHaveLength(0);
    expect(db.prepare('SELECT status FROM payment_notifications WHERE id = ?').get(id).status).toBe('unmatched');
  });

  it('a part payment leaves the order part paid', async () => {
    const o = await dispatchedOrder({ price: 100000 });
    const id = payment({ amount: 40000 });
    const r = await request(app).post(`/api/v1/payments/${id}/match`).set(auth(manager)).send({ orderId: o.id });
    expect(r.body.order).toMatchObject({ paymentState: 'partial', balanceCents: o.total - 40000 });
    expect(orderRow(o.id).status).toBe('dispatched_partial');
  });

  it('refuses an unknown order or one that cannot take a payment', async () => {
    const id = payment({ amount: 1000 });
    expect((await request(app).post(`/api/v1/payments/${id}/match`).set(auth(manager)).send({ orderId: 999999 })).body.error.code).toBe('ORDER_NOT_FOUND');
    seq += 1;
    const p = H.makeProduct({ sell: 10000 });
    const undispatched = await web(request(app).post('/api/orders')).send({ name: 'Not Sent', phone: `0777${String(seq).padStart(6, '0')}`, payment_type: 'prepaid', items: [{ product_id: p.id, quantity: 1 }] });
    const r = await request(app).post(`/api/v1/payments/${id}/match`).set(auth(manager)).send({ orderId: undispatched.body.data.id });
    expect(r.status).toBe(409); expect(r.body.error.code).toBe('ORDER_NOT_PAYABLE');
    expect((await request(app).post('/api/v1/payments/999999/match').set(auth(manager)).send({ orderId: 1 })).status).toBe(404);
  });
});

describe('ignoring', () => {
  it('needs a reason, records it, and cannot be done twice or after a match', async () => {
    const id = payment({ amount: 5000 });
    expect((await request(app).post(`/api/v1/payments/${id}/ignore`).set(auth(manager)).send({})).status).toBe(400);
    const r = await request(app).post(`/api/v1/payments/${id}/ignore`).set(auth(manager)).send({ reason: 'Refunded to the sender' });
    expect(r.status).toBe(200); expect(r.body.payment.status).toBe('ignored');
    expect(H.lastLog('payment_notification', id).changes.reason.to).toBe('Refunded to the sender');
    expect((await request(app).post(`/api/v1/payments/${id}/ignore`).set(auth(manager)).send({ reason: 'again again' })).body.error.code).toBe('ALREADY_IGNORED');
    const o = await dispatchedOrder({ price: 5000 });
    expect((await request(app).post(`/api/v1/payments/${id}/match`).set(auth(manager)).send({ orderId: o.id })).body.error.code).toBe('ALREADY_IGNORED');
    const listed = await request(app).get('/api/v1/payments/unmatched?limit=100').set(auth(manager));
    expect(listed.body.items.find((i) => i.id === id)).toBeUndefined();
  });
});
