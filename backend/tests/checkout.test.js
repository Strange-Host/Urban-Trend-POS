const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let token;
let product;

beforeAll(async () => {
  token = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
  product = res.body.data[0];
});

afterAll(() => cleanupTestDb());

describe('checkout', () => {
  it('charges exactly the line price — no tax added on top', async () => {
    const res = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: product.id, quantity: 1 }], payments: [{ method: 'cash', amount: product.sell_price }] });
    expect(res.status).toBe(201);
    expect(res.body.data.total).toBe(product.sell_price);
    expect(res.body.data.tax_total).toBe(0);
  });

  it('rejects a payment that does not match the sale total', async () => {
    const res = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: product.id, quantity: 1 }], payments: [{ method: 'cash', amount: product.sell_price * 1.16 }] });
    expect(res.status).toBe(400);
  });

  it('rejects a sale that exceeds available stock', async () => {
    const res = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: product.id, quantity: 999999 }], payments: [{ method: 'cash', amount: 999999 * product.sell_price }] });
    expect(res.status).toBe(409);
  });

  it('decrements inventory on checkout and restores it on void', async () => {
    const beforeRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    const stockBefore = beforeRes.body.data[0].total_stock;

    const saleRes = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: product.id, quantity: 2 }], payments: [{ method: 'cash', amount: product.sell_price * 2 }] });
    expect(saleRes.status).toBe(201);

    const afterSaleRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    expect(afterSaleRes.body.data[0].total_stock).toBe(stockBefore - 2);

    const voidRes = await request(app)
      .post(`/api/sales/${saleRes.body.data.id}/void`)
      .set('Authorization', `Bearer ${token}`);
    expect(voidRes.status).toBe(200);

    const afterVoidRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
    expect(afterVoidRes.body.data[0].total_stock).toBe(stockBefore);
  });

  it('refuses to void an already-voided sale', async () => {
    const saleRes = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: product.id, quantity: 1 }], payments: [{ method: 'cash', amount: product.sell_price }] });
    const saleId = saleRes.body.data.id;

    const firstVoid = await request(app).post(`/api/sales/${saleId}/void`).set('Authorization', `Bearer ${token}`);
    expect(firstVoid.status).toBe(200);

    const secondVoid = await request(app).post(`/api/sales/${saleId}/void`).set('Authorization', `Bearer ${token}`);
    expect(secondVoid.status).toBe(409);
  });
});
