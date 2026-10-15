const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let token;
let product;

beforeAll(async () => {
  token = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
  product = res.body.data[0];
});

afterAll(() => cleanupTestDb());

describe('requisitions', () => {
  it('approving a requisition auto-increments inventory by the approved quantity', async () => {
    const beforeRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    const stockBefore = beforeRes.body.data[0].total_stock;

    const createRes = await request(app)
      .post('/api/requisitions')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: product.id, quantity_requested: 10 }] });
    expect(createRes.status).toBe(201);
    const requisitionId = createRes.body.data.id;

    const approveRes = await request(app)
      .patch(`/api/requisitions/${requisitionId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: product.id, quantity_approved: 10 }] });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe('approved');

    const afterRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    expect(afterRes.body.data[0].total_stock).toBe(stockBefore + 10);
  });

  it('a partial approval only adds the approved quantity, not the requested one', async () => {
    const beforeRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    const stockBefore = beforeRes.body.data[0].total_stock;

    const createRes = await request(app)
      .post('/api/requisitions')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: product.id, quantity_requested: 20 }] });
    const requisitionId = createRes.body.data.id;

    await request(app)
      .patch(`/api/requisitions/${requisitionId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: product.id, quantity_approved: 5 }] });

    const afterRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    expect(afterRes.body.data[0].total_stock).toBe(stockBefore + 5);
  });

  it('refuses to approve an already-approved requisition', async () => {
    const createRes = await request(app)
      .post('/api/requisitions')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: product.id, quantity_requested: 1 }] });
    const requisitionId = createRes.body.data.id;

    const first = await request(app)
      .patch(`/api/requisitions/${requisitionId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: product.id, quantity_approved: 1 }] });
    expect(first.status).toBe(200);

    const second = await request(app)
      .patch(`/api/requisitions/${requisitionId}/approve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: product.id, quantity_approved: 1 }] });
    expect(second.status).toBe(409);
  });
});
