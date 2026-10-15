process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret';

const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let token;
let product;
let storeId;

beforeAll(async () => {
  token = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
  product = res.body.data[0];
  const meRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ name: 'Store Probe', phone: '0755000000', payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] });
  storeId = meRes.body.data.store_id;
});

afterAll(() => cleanupTestDb());

async function createDispatchedOrder(phone) {
  const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ name: 'Recon Test', phone, payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] });
  const order = createRes.body.data;
  await request(app).post(`/api/orders/${order.id}/dispatch`).set('Authorization', `Bearer ${token}`);
  return order;
}

describe('payment reconciliation (Phase 3)', () => {
  it('generates a unique product_code for every order', async () => {
    const res = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Code Test', phone: '0755000001', items: [{ product_id: product.id, quantity: 1 }] });
    expect(res.body.data.product_code).toMatch(/^UT\d{6}$/);
  });

  it('rejects a webhook call without the correct secret', async () => {
    const res = await request(app).post('/api/integrations/payments/kcb/webhook')
      .send({ store_id: storeId, method: 'mobile_money', amount: 1000, narrative: 'UT000001' });
    expect(res.status).toBe(401);

    const wrongRes = await request(app).post('/api/integrations/payments/kcb/webhook')
      .set('X-Webhook-Secret', 'wrong-secret')
      .send({ store_id: storeId, method: 'mobile_money', amount: 1000, narrative: 'UT000001' });
    expect(wrongRes.status).toBe(401);
  });

  it('auto-matches a webhook payment to the order by product code and marks it paid', async () => {
    const order = await createDispatchedOrder('0755000002');

    const webhookRes = await request(app).post('/api/integrations/payments/kcb/webhook')
      .set('X-Webhook-Secret', 'test-webhook-secret')
      .send({
        store_id: storeId, method: 'mobile_money', amount: order.total,
        external_reference: 'KCB-TXN-001', narrative: order.product_code, payer_name: 'Jane Payer',
      });
    expect(webhookRes.status).toBe(201);
    expect(webhookRes.body.data.status).toBe('matched');
    expect(webhookRes.body.data.order_id).toBe(order.id);

    const orderRes = await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${token}`);
    expect(orderRes.body.data.status).toBe('dispatched_paid');
    expect(orderRes.body.data.amount_paid).toBe(order.total);
  });

  it('is idempotent — the same external_reference delivered twice only applies the payment once', async () => {
    const order = await createDispatchedOrder('0755000003');
    const payload = {
      store_id: storeId, method: 'mobile_money', amount: order.total,
      external_reference: 'KCB-TXN-DUPLICATE', narrative: order.product_code,
    };

    const firstRes = await request(app).post('/api/integrations/payments/kcb/webhook')
      .set('X-Webhook-Secret', 'test-webhook-secret').send(payload);
    const secondRes = await request(app).post('/api/integrations/payments/kcb/webhook')
      .set('X-Webhook-Secret', 'test-webhook-secret').send(payload);

    expect(firstRes.body.data.id).toBe(secondRes.body.data.id); // same notification row, not a new one

    const orderRes = await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${token}`);
    expect(orderRes.body.data.amount_paid).toBe(order.total); // NOT double-applied
  });

  it('flags a payment with no matching product code as unmatched, visible in the review queue', async () => {
    const webhookRes = await request(app).post('/api/integrations/payments/kcb/webhook')
      .set('X-Webhook-Secret', 'test-webhook-secret')
      .send({ store_id: storeId, method: 'mobile_money', amount: 50000, external_reference: 'KCB-TXN-NOCODE', narrative: 'no code in here' });
    expect(webhookRes.status).toBe(201);
    expect(webhookRes.body.data.status).toBe('unmatched');
    expect(webhookRes.body.data.order_id).toBeNull();

    const listRes = await request(app).get('/api/payment-reconciliation/unmatched').set('Authorization', `Bearer ${token}`);
    expect(listRes.body.data.some((n) => n.id === webhookRes.body.data.id)).toBe(true);
  });

  it('flags a payment against a non-payable order (still awaiting dispatch) as unmatched, not silently dropped', async () => {
    const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Not Dispatched Yet', phone: '0755000004', items: [{ product_id: product.id, quantity: 1 }] });
    const order = createRes.body.data;

    const webhookRes = await request(app).post('/api/integrations/payments/mpesa/webhook')
      .set('X-Webhook-Secret', 'test-webhook-secret')
      .send({ store_id: storeId, method: 'mobile_money', amount: order.total, external_reference: 'MPESA-EARLY-PAY', narrative: order.product_code });
    expect(webhookRes.status).toBe(201);
    expect(webhookRes.body.data.status).toBe('unmatched');
    expect(webhookRes.body.data.matched_code).toBe(order.product_code);
    expect(webhookRes.body.data.order_id).toBeNull(); // found the order, but couldn't apply — surfaced for a human, not auto-resolved
  });

  it('lets staff manually match an unmatched notification to an order (the "spouse pays for the order" case)', async () => {
    const order = await createDispatchedOrder('0755000005');

    const webhookRes = await request(app).post('/api/integrations/payments/mpesa/webhook')
      .set('X-Webhook-Secret', 'test-webhook-secret')
      .send({ store_id: storeId, method: 'mobile_money', amount: order.total, external_reference: 'MPESA-SPOUSE-PAY', payer_name: 'Peter (paying for Martha)' });
    expect(webhookRes.body.data.status).toBe('unmatched'); // no code in the narrative at all

    const matchRes = await request(app).post(`/api/payment-reconciliation/${webhookRes.body.data.id}/match`).set('Authorization', `Bearer ${token}`)
      .send({ order_id: order.id });
    expect(matchRes.status).toBe(200);
    expect(matchRes.body.data.status).toBe('matched');

    const orderRes = await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${token}`);
    expect(orderRes.body.data.status).toBe('dispatched_paid');
  });

  it('lets staff ignore an unmatched notification (e.g. a test transaction)', async () => {
    const webhookRes = await request(app).post('/api/integrations/payments/kcb/webhook')
      .set('X-Webhook-Secret', 'test-webhook-secret')
      .send({ store_id: storeId, method: 'mobile_money', amount: 100, external_reference: 'KCB-TEST-TXN' });

    const ignoreRes = await request(app).post(`/api/payment-reconciliation/${webhookRes.body.data.id}/ignore`).set('Authorization', `Bearer ${token}`);
    expect(ignoreRes.status).toBe(200);
    expect(ignoreRes.body.data.status).toBe('ignored');

    const listRes = await request(app).get('/api/payment-reconciliation/unmatched').set('Authorization', `Bearer ${token}`);
    expect(listRes.body.data.some((n) => n.id === webhookRes.body.data.id)).toBe(false);
  });
});
