const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let token;
let product;

beforeAll(async () => {
  token = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
  product = res.body.data[0];
});

afterAll(() => cleanupTestDb());

describe('orders (online/COD lifecycle)', () => {
  it('creates an order in awaiting_dispatch without touching stock', async () => {
    const beforeRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    const stockBefore = beforeRes.body.data[0].total_stock;

    const res = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Martha Kisumu', phone: '0733000001', items: [{ product_id: product.id, quantity: 1 }] });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('awaiting_dispatch');
    expect(res.body.data.customer.phone).toBe('0733000001');

    const afterRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    expect(afterRes.body.data[0].total_stock).toBe(stockBefore);
  });

  it('rejects a second active order for the same phone (duplicate prevention)', async () => {
    const firstRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Duplicate Phone Test', phone: '0733000002', items: [{ product_id: product.id, quantity: 1 }] });
    expect(firstRes.status).toBe(201);

    const dupRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Duplicate Phone Test', phone: '0733000002', items: [{ product_id: product.id, quantity: 1 }] });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.details.existingOrderId).toBe(firstRes.body.data.id);
  });

  it('merges additional items into an awaiting_dispatch order', async () => {
    const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Merge Test', phone: '0733000003', items: [{ product_id: product.id, quantity: 1 }] });
    const orderId = createRes.body.data.id;
    const originalTotal = createRes.body.data.total;

    const mergeRes = await request(app).post(`/api/orders/${orderId}/merge-items`).set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: product.id, quantity: 1 }] });
    expect(mergeRes.status).toBe(200);
    expect(mergeRes.body.data.total).toBe(originalTotal * 2);
  });

  it('dispatch deducts stock exactly once and rejects insufficient stock', async () => {
    const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ payment_type: 'prepaid', name: 'Dispatch Test', phone: '0733000004', items: [{ product_id: product.id, quantity: 2 }] });
    const orderId = createRes.body.data.id;

    const beforeRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    const stockBefore = beforeRes.body.data[0].total_stock;

    const dispatchRes = await request(app).post(`/api/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${token}`);
    expect(dispatchRes.status).toBe(200);
    expect(dispatchRes.body.data.status).toBe('dispatched_unpaid');

    const afterRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    expect(afterRes.body.data[0].total_stock).toBe(stockBefore - 2);

    // Can't dispatch twice — already past awaiting_dispatch.
    const secondDispatchRes = await request(app).post(`/api/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${token}`);
    expect(secondDispatchRes.status).toBe(409);

    // A fresh order for way more than available stock is rejected before dispatch touches anything.
    const bigOrderRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Too Big Test', phone: '0733000005', items: [{ product_id: product.id, quantity: 999999 }] });
    const bigDispatchRes = await request(app).post(`/api/orders/${bigOrderRes.body.data.id}/dispatch`).set('Authorization', `Bearer ${token}`);
    expect(bigDispatchRes.status).toBe(409);
  });

  it('partial then full payment moves dispatched_unpaid -> dispatched_partial -> dispatched_paid', async () => {
    const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ payment_type: 'prepaid', name: 'Payment Test', phone: '0733000006', items: [{ product_id: product.id, quantity: 1 }] });
    const orderId = createRes.body.data.id;
    const total = createRes.body.data.total;
    await request(app).post(`/api/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${token}`);

    const partialRes = await request(app).post(`/api/orders/${orderId}/payments`).set('Authorization', `Bearer ${token}`)
      .send({ method: 'mobile_money', amount: Math.floor(total / 2), reference: 'MPESA123' });
    expect(partialRes.status).toBe(201);
    expect(partialRes.body.data.status).toBe('dispatched_partial');

    const fullRes = await request(app).post(`/api/orders/${orderId}/payments`).set('Authorization', `Bearer ${token}`)
      .send({ method: 'mobile_money', amount: total - Math.floor(total / 2), reference: 'MPESA456' });
    expect(fullRes.status).toBe(201);
    expect(fullRes.body.data.status).toBe('dispatched_paid');
  });

  it('return flow: in transit -> awaiting inspection -> resellable reinstates stock', async () => {
    const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ payment_type: 'prepaid', name: 'Return Good Test', phone: '0733000007', items: [{ product_id: product.id, quantity: 1 }] });
    const orderId = createRes.body.data.id;
    await request(app).post(`/api/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${token}`);

    const beforeReturnRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    const stockAfterDispatch = beforeReturnRes.body.data[0].total_stock;

    await request(app).post(`/api/orders/${orderId}/returned-in-transit`).set('Authorization', `Bearer ${token}`).send({});
    await request(app).post(`/api/orders/${orderId}/returned-awaiting-inspection`).set('Authorization', `Bearer ${token}`);

    // Stock stays deducted until inspection actually completes.
    const stillDownRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    expect(stillDownRes.body.data[0].total_stock).toBe(stockAfterDispatch);

    const inspectRes = await request(app).post(`/api/orders/${orderId}/inspect`).set('Authorization', `Bearer ${token}`)
      .send({ result: 'good' });
    expect(inspectRes.status).toBe(200);
    expect(inspectRes.body.data.status).toBe('returned_resellable');

    const afterInspectRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    expect(afterInspectRes.body.data[0].total_stock).toBe(stockAfterDispatch + 1);
  });

  it('a damaged return does NOT reinstate stock', async () => {
    const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ payment_type: 'prepaid', name: 'Return Damaged Test', phone: '0733000008', items: [{ product_id: product.id, quantity: 1 }] });
    const orderId = createRes.body.data.id;
    await request(app).post(`/api/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${token}`);
    await request(app).post(`/api/orders/${orderId}/returned-in-transit`).set('Authorization', `Bearer ${token}`).send({});
    await request(app).post(`/api/orders/${orderId}/returned-awaiting-inspection`).set('Authorization', `Bearer ${token}`);

    const beforeInspectRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    const stockBeforeInspect = beforeInspectRes.body.data[0].total_stock;

    const inspectRes = await request(app).post(`/api/orders/${orderId}/inspect`).set('Authorization', `Bearer ${token}`)
      .send({ result: 'damaged' });
    expect(inspectRes.status).toBe(200);
    expect(inspectRes.body.data.status).toBe('returned_damaged');

    const afterInspectRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    expect(afterInspectRes.body.data[0].total_stock).toBe(stockBeforeInspect);
  });

  it('flags a customer as risky after repeated returns, and still allows a new order (prepay case)', async () => {
    const phone = '0733000009';
    let lastOrderId;
    for (let i = 0; i < 3; i++) {
      const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
        .send({ payment_type: 'prepaid', name: 'Repeat Rejecter', phone, items: [{ product_id: product.id, quantity: 1 }] });
      expect(createRes.status).toBe(201); // a returned_in_transit order from a prior loop iteration never blocks the next one
      lastOrderId = createRes.body.data.id;
      await request(app).post(`/api/orders/${lastOrderId}/dispatch`).set('Authorization', `Bearer ${token}`);
      await request(app).post(`/api/orders/${lastOrderId}/returned-in-transit`).set('Authorization', `Bearer ${token}`).send({});
    }

    const getRes = await request(app).get(`/api/orders/${lastOrderId}`).set('Authorization', `Bearer ${token}`);
    expect(getRes.body.data.customer.risk_flag).toBe('high');
    expect(getRes.body.data.customer.prepay_required).toBe(1);
  });

  it('rejects an illegal transition (cannot inspect before returned_awaiting_inspection)', async () => {
    const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ payment_type: 'prepaid', name: 'Illegal Transition Test', phone: '0733000010', items: [{ product_id: product.id, quantity: 1 }] });
    const orderId = createRes.body.data.id;

    const badRes = await request(app).post(`/api/orders/${orderId}/inspect`).set('Authorization', `Bearer ${token}`)
      .send({ result: 'good' });
    expect(badRes.status).toBe(409); // still awaiting_dispatch — inspect is only legal from returned_awaiting_inspection
  });

  it('cancels an order before dispatch', async () => {
    const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ payment_type: 'prepaid', name: 'Cancel Test', phone: '0733000011', items: [{ product_id: product.id, quantity: 1 }] });
    const orderId = createRes.body.data.id;

    const cancelRes = await request(app).post(`/api/orders/${orderId}/cancel`).set('Authorization', `Bearer ${token}`).send({});
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe('cancelled');

    const secondCancelRes = await request(app).post(`/api/orders/${orderId}/cancel`).set('Authorization', `Bearer ${token}`).send({});
    expect(secondCancelRes.status).toBe(409);
  });
});
