const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let token;
let product;

beforeAll(async () => {
  token = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
  product = res.body.data[0];
});

afterAll(() => cleanupTestDb());

async function createDispatchedOrder(phone) {
  const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ name: 'RMA Test', phone, payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] });
  const orderId = createRes.body.data.id;
  await request(app).post(`/api/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${token}`);
  return orderId;
}

describe('orders — Phase 4 (return reason codes & owner write-off decision)', () => {
  it('records a return reason code when a parcel starts heading back', async () => {
    const orderId = await createDispatchedOrder('0766000001');
    const res = await request(app).post(`/api/orders/${orderId}/returned-in-transit`).set('Authorization', `Bearer ${token}`)
      .send({ reason_code: 'wrong_item', notes: 'Customer says wrong size sent' });
    expect(res.status).toBe(200);
    expect(res.body.data.return_reason).toBe('wrong_item');
  });

  it('rejects an invalid reason code', async () => {
    const orderId = await createDispatchedOrder('0766000002');
    const res = await request(app).post(`/api/orders/${orderId}/returned-in-transit`).set('Authorization', `Bearer ${token}`)
      .send({ reason_code: 'not_a_real_reason' });
    expect(res.status).toBe(400);
  });

  it('still works without a reason code (backwards compatible with Phases 1-3)', async () => {
    const orderId = await createDispatchedOrder('0766000003');
    const res = await request(app).post(`/api/orders/${orderId}/returned-in-transit`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.return_reason).toBeNull();
  });

  it('flags owner_notified_at the moment an inspection comes back damaged, not on a good inspection', async () => {
    const goodOrderId = await createDispatchedOrder('0766000004');
    await request(app).post(`/api/orders/${goodOrderId}/returned-in-transit`).set('Authorization', `Bearer ${token}`).send({});
    await request(app).post(`/api/orders/${goodOrderId}/returned-awaiting-inspection`).set('Authorization', `Bearer ${token}`);
    const goodRes = await request(app).post(`/api/orders/${goodOrderId}/inspect`).set('Authorization', `Bearer ${token}`).send({ result: 'good' });
    expect(goodRes.body.data.owner_notified_at).toBeNull();

    const damagedOrderId = await createDispatchedOrder('0766000005');
    await request(app).post(`/api/orders/${damagedOrderId}/returned-in-transit`).set('Authorization', `Bearer ${token}`).send({ reason_code: 'damaged' });
    await request(app).post(`/api/orders/${damagedOrderId}/returned-awaiting-inspection`).set('Authorization', `Bearer ${token}`);
    const damagedRes = await request(app).post(`/api/orders/${damagedOrderId}/inspect`).set('Authorization', `Bearer ${token}`).send({ result: 'damaged' });
    expect(damagedRes.body.data.owner_notified_at).toBeTruthy();
    expect(damagedRes.body.data.owner_decision).toBeNull();
  });

  it('lists a damaged order in the pending-owner-decision queue until it is decided', async () => {
    const orderId = await createDispatchedOrder('0766000006');
    await request(app).post(`/api/orders/${orderId}/returned-in-transit`).set('Authorization', `Bearer ${token}`).send({});
    await request(app).post(`/api/orders/${orderId}/returned-awaiting-inspection`).set('Authorization', `Bearer ${token}`);
    await request(app).post(`/api/orders/${orderId}/inspect`).set('Authorization', `Bearer ${token}`).send({ result: 'damaged' });

    const pendingRes = await request(app).get('/api/orders/pending-owner-decision').set('Authorization', `Bearer ${token}`);
    expect(pendingRes.status).toBe(200);
    expect(pendingRes.body.data.some((o) => o.id === orderId)).toBe(true);

    const decideRes = await request(app).post(`/api/orders/${orderId}/owner-decision`).set('Authorization', `Bearer ${token}`)
      .send({ decision: 'write_off', notes: 'Beyond repair' });
    expect(decideRes.status).toBe(200);
    expect(decideRes.body.data.owner_decision).toBe('write_off');
    expect(decideRes.body.data.owner_decision_notes).toBe('Beyond repair');

    const afterDecisionRes = await request(app).get('/api/orders/pending-owner-decision').set('Authorization', `Bearer ${token}`);
    expect(afterDecisionRes.body.data.some((o) => o.id === orderId)).toBe(false);
  });

  it('rejects a second owner decision on an already-decided order', async () => {
    const orderId = await createDispatchedOrder('0766000007');
    await request(app).post(`/api/orders/${orderId}/returned-in-transit`).set('Authorization', `Bearer ${token}`).send({});
    await request(app).post(`/api/orders/${orderId}/returned-awaiting-inspection`).set('Authorization', `Bearer ${token}`);
    await request(app).post(`/api/orders/${orderId}/inspect`).set('Authorization', `Bearer ${token}`).send({ result: 'damaged' });

    const firstRes = await request(app).post(`/api/orders/${orderId}/owner-decision`).set('Authorization', `Bearer ${token}`)
      .send({ decision: 'dispose' });
    expect(firstRes.status).toBe(200);

    const secondRes = await request(app).post(`/api/orders/${orderId}/owner-decision`).set('Authorization', `Bearer ${token}`)
      .send({ decision: 'write_off' });
    expect(secondRes.status).toBe(409);
  });

  it('rejects an owner decision on an order that was not inspected as damaged', async () => {
    const orderId = await createDispatchedOrder('0766000008');
    await request(app).post(`/api/orders/${orderId}/returned-in-transit`).set('Authorization', `Bearer ${token}`).send({});
    await request(app).post(`/api/orders/${orderId}/returned-awaiting-inspection`).set('Authorization', `Bearer ${token}`);
    await request(app).post(`/api/orders/${orderId}/inspect`).set('Authorization', `Bearer ${token}`).send({ result: 'good' });

    const res = await request(app).post(`/api/orders/${orderId}/owner-decision`).set('Authorization', `Bearer ${token}`)
      .send({ decision: 'write_off' });
    expect(res.status).toBe(409);
  });
});
