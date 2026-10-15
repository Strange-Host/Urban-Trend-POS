const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let token;
let product;

beforeAll(async () => {
  token = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
  product = res.body.data[0];
});

afterAll(() => cleanupTestDb());

async function createPaidOrder(phone) {
  const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ name: 'Dispute Test', phone, payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] });
  const orderId = createRes.body.data.id;
  await request(app).post(`/api/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${token}`);
  return orderId;
}

describe('order disputes (Phase 8)', () => {
  it('opens a dispute on an order and rejects opening a second one while it is still open', async () => {
    const orderId = await createPaidOrder('0755900001');
    const res = await request(app).post(`/api/orders/${orderId}/dispute`).set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Customer says parcel never arrived' });
    expect(res.status).toBe(201);
    expect(res.body.data.dispute_status).toBe('open');

    const secondRes = await request(app).post(`/api/orders/${orderId}/dispute`).set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Another complaint' });
    expect(secondRes.status).toBe(409);
  });

  it('resolves a dispute with an outcome, and rejects resolving one that is not open', async () => {
    const orderId = await createPaidOrder('0755900002');
    await request(app).post(`/api/orders/${orderId}/dispute`).set('Authorization', `Bearer ${token}`)
      .send({ reason: 'Wrong item delivered' });

    const resolveRes = await request(app).post(`/api/orders/${orderId}/dispute/resolve`).set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'redelivered', notes: 'Correct item sent out again' });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.data.dispute_status).toBe('resolved');
    expect(resolveRes.body.data.dispute_outcome).toBe('redelivered');

    const secondResolveRes = await request(app).post(`/api/orders/${orderId}/dispute/resolve`).set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'refund' });
    expect(secondResolveRes.status).toBe(409);
  });

  it('rejects resolving a dispute that was never opened', async () => {
    const orderId = await createPaidOrder('0755900003');
    const res = await request(app).post(`/api/orders/${orderId}/dispute/resolve`).set('Authorization', `Bearer ${token}`)
      .send({ outcome: 'closed' });
    expect(res.status).toBe(409);
  });

  it('requires a reason to open a dispute', async () => {
    const orderId = await createPaidOrder('0755900004');
    const res = await request(app).post(`/api/orders/${orderId}/dispute`).set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });
});
