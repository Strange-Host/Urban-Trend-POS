const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let token;
let product; // cheap product (< KSh 5,000 for a single unit) — used for the flat delivery fee tier
let expensiveProduct; // used to push an order's total above the KSh 5,000 delivery-fee threshold

beforeAll(async () => {
  token = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=25').set('Authorization', `Bearer ${token}`);
  product = res.body.data.find((p) => p.sell_price < 500000); // < KSh 5,000
  expensiveProduct = res.body.data.find((p) => p.sell_price >= 200000); // Sneakers etc — a couple of these clears the threshold
});

afterAll(() => cleanupTestDb());

describe('orders — Phase 2 (courier, delivery zone/fee, COD confirmation gate)', () => {
  it('auto-suggests a courier and delivery zone from the customer\'s city, and defaults payment_type to cod', async () => {
    const nairobiRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nairobi Customer', phone: '0744000001', city: 'Nairobi', items: [{ product_id: product.id, quantity: 1 }] });
    expect(nairobiRes.status).toBe(201);
    expect(nairobiRes.body.data.delivery_zone).toBe('nairobi');
    expect(nairobiRes.body.data.courier_type).toBe('boda');
    expect(nairobiRes.body.data.payment_type).toBe('cod');
    expect(nairobiRes.body.data.cod_confirmation_expires_at).toBeTruthy();

    const outsideRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Nakuru Customer', phone: '0744000002', city: 'Nakuru', items: [{ product_id: product.id, quantity: 1 }] });
    expect(outsideRes.status).toBe(201);
    expect(outsideRes.body.data.delivery_zone).toBe('outside');
    expect(outsideRes.body.data.courier_type).toBe('g4s');
  });

  it('applies the flat delivery fee under the threshold and the percentage fee above it', async () => {
    const cheapRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Cheap Order', phone: '0744000003', city: 'Nairobi', items: [{ product_id: product.id, quantity: 1 }] });
    expect(cheapRes.body.data.total).toBeLessThan(500000); // under KSh 5,000
    expect(cheapRes.body.data.delivery_fee).toBe(30000); // flat KSh 300

    const bigRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Big Order', phone: '0744000004', city: 'Nairobi', items: [{ product_id: expensiveProduct.id, quantity: 3 }] });
    expect(bigRes.body.data.total).toBeGreaterThanOrEqual(500000); // at/over KSh 5,000
    expect(bigRes.body.data.delivery_fee).toBe(Math.round(bigRes.body.data.total * 0.05));
  });

  it('lets staff override the auto-suggested courier while still awaiting dispatch', async () => {
    const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Override Test', phone: '0744000005', city: 'Nairobi', items: [{ product_id: product.id, quantity: 1 }] });
    expect(createRes.body.data.courier_type).toBe('boda');

    const overrideRes = await request(app).post(`/api/orders/${createRes.body.data.id}/courier`).set('Authorization', `Bearer ${token}`)
      .send({ courier_type: 'g4s' });
    expect(overrideRes.status).toBe(200);
    expect(overrideRes.body.data.courier_type).toBe('g4s');
  });

  it('blocks dispatch of an unconfirmed COD order, and allows it once confirmed', async () => {
    const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Confirmation Gate Test', phone: '0744000006', city: 'Nairobi', items: [{ product_id: product.id, quantity: 1 }] });
    const orderId = createRes.body.data.id;

    const blockedDispatchRes = await request(app).post(`/api/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${token}`);
    expect(blockedDispatchRes.status).toBe(409);

    const confirmRes = await request(app).post(`/api/orders/${orderId}/confirm-cod`).set('Authorization', `Bearer ${token}`);
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.data.cod_confirmed_at).toBeTruthy();

    // Confirming twice is rejected.
    const doubleConfirmRes = await request(app).post(`/api/orders/${orderId}/confirm-cod`).set('Authorization', `Bearer ${token}`);
    expect(doubleConfirmRes.status).toBe(409);

    const dispatchRes = await request(app).post(`/api/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${token}`);
    expect(dispatchRes.status).toBe(200);
    expect(dispatchRes.body.data.status).toBe('dispatched_unpaid');
  });

  it('does not require COD confirmation for a prepaid order', async () => {
    const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Prepaid Test', phone: '0744000007', city: 'Nairobi', payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] });
    expect(createRes.body.data.payment_type).toBe('prepaid');
    expect(createRes.body.data.cod_confirmation_expires_at).toBeNull();

    const dispatchRes = await request(app).post(`/api/orders/${createRes.body.data.id}/dispatch`).set('Authorization', `Bearer ${token}`);
    expect(dispatchRes.status).toBe(200); // no confirmation needed — dispatches straight away
  });

  it('auto-cancels an unconfirmed COD order once its confirmation window elapses', async () => {
    // Shrink the window to effectively zero for this test, then restore it —
    // avoids waiting on the real default window (2 hours) or the 15-minute scheduler.
    // (A negative window used to be the shortcut here, but SQLite reads the
    // modifier "+-1 minutes" as invalid and returns NULL, so no expiry was ever
    // stored and the sweep had nothing to expire. Back-date the stored expiry instead.)
    const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Expiry Test', phone: '0744000008', city: 'Nairobi', items: [{ product_id: product.id, quantity: 1 }] });
    const orderId = createRes.body.data.id;
    require('../src/config/db').prepare(`UPDATE orders SET cod_confirmation_expires_at = datetime('now', '-1 minutes') WHERE id = ?`).run(orderId);

    const sweepRes = await request(app).post('/api/orders/expire-unconfirmed').set('Authorization', `Bearer ${token}`);
    expect(sweepRes.status).toBe(200);
    expect(sweepRes.body.data.expiredOrderIds).toContain(orderId);

    const getRes = await request(app).get(`/api/orders/${orderId}`).set('Authorization', `Bearer ${token}`);
    expect(getRes.body.data.status).toBe('cancelled');

    // Restore a sane window so later tests (and anyone re-running this suite) aren't affected.
    await request(app).put('/api/settings').set('Authorization', `Bearer ${token}`)
      .send({ cod_confirmation_window_minutes: '120' });
  });
});
