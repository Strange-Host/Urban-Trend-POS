const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let token;
let product;

beforeAll(async () => {
  token = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
  product = res.body.data[0];
});

afterAll(() => cleanupTestDb());

async function stockFor(productId) {
  const res = await request(app).get(`/api/products?pageSize=50`).set('Authorization', `Bearer ${token}`);
  return res.body.data.find((p) => p.id === productId).total_stock;
}

describe('offline sale idempotency (clientSaleId)', () => {
  it('re-sending the same clientSaleId returns the original sale and never double-deducts stock', async () => {
    const before = await stockFor(product.id);
    const payload = {
      items: [{ product_id: product.id, quantity: 2 }],
      payments: [{ method: 'cash', amount: product.sell_price * 2 }],
      clientSaleId: 'test-offline-uuid-0001',
    };

    const first = await request(app).post('/api/sales').set('Authorization', `Bearer ${token}`).send(payload);
    expect(first.status).toBe(201);
    const saleId = first.body.data.id;
    expect(await stockFor(product.id)).toBe(before - 2);

    // The register reconnects and retries the queued sale.
    const retry = await request(app).post('/api/sales').set('Authorization', `Bearer ${token}`).send(payload);
    expect(retry.status).toBe(201);
    expect(retry.body.data.id).toBe(saleId); // same sale, not a new one
    expect(await stockFor(product.id)).toBe(before - 2); // stock deducted exactly once

    // And a third time, for good measure.
    const retry2 = await request(app).post('/api/sales').set('Authorization', `Bearer ${token}`).send(payload);
    expect(retry2.body.data.id).toBe(saleId);
    expect(await stockFor(product.id)).toBe(before - 2);
  });

  it('two different clientSaleIds are two genuinely different sales', async () => {
    const before = await stockFor(product.id);
    const base = {
      items: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'cash', amount: product.sell_price }],
    };

    const a = await request(app).post('/api/sales').set('Authorization', `Bearer ${token}`)
      .send({ ...base, clientSaleId: 'test-offline-uuid-A' });
    const b = await request(app).post('/api/sales').set('Authorization', `Bearer ${token}`)
      .send({ ...base, clientSaleId: 'test-offline-uuid-B' });

    expect(a.body.data.id).not.toBe(b.body.data.id);
    expect(await stockFor(product.id)).toBe(before - 2);
  });

  it('an ordinary online sale with no clientSaleId still works (unchanged behaviour)', async () => {
    const before = await stockFor(product.id);
    const res = await request(app).post('/api/sales').set('Authorization', `Bearer ${token}`).send({
      items: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'cash', amount: product.sell_price }],
    });
    expect(res.status).toBe(201);
    expect(await stockFor(product.id)).toBe(before - 1);

    // Two no-clientSaleId sales are always distinct — the unique index is
    // partial (WHERE client_sale_id IS NOT NULL), so NULLs never collide.
    const res2 = await request(app).post('/api/sales').set('Authorization', `Bearer ${token}`).send({
      items: [{ product_id: product.id, quantity: 1 }],
      payments: [{ method: 'cash', amount: product.sell_price }],
    });
    expect(res2.status).toBe(201);
    expect(res2.body.data.id).not.toBe(res.body.data.id);
  });

  it('a queued sale that the server genuinely rejects still fails (not silently accepted)', async () => {
    const res = await request(app).post('/api/sales').set('Authorization', `Bearer ${token}`).send({
      items: [{ product_id: product.id, quantity: 999999 }],
      payments: [{ method: 'cash', amount: product.sell_price * 999999 }],
      clientSaleId: 'test-offline-uuid-toomuch',
    });
    expect(res.status).toBe(409); // insufficient stock — the client marks this failed rather than retrying forever
  });
});
