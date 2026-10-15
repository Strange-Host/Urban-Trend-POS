const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let token;
let product;

beforeAll(async () => {
  token = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
  product = res.body.data[0];
});

afterAll(() => cleanupTestDb());

describe('cash sessions', () => {
  it('has no open session before one is opened', async () => {
    const res = await request(app).get('/api/cash-sessions/current').set('Authorization', `Bearer ${token}`);
    expect(res.body.data).toBeNull();
  });

  it('opens a session, refuses a second one, and auto-attaches it to a checkout', async () => {
    const openRes = await request(app)
      .post('/api/cash-sessions/open')
      .set('Authorization', `Bearer ${token}`)
      .send({ openingAmount: 5000 });
    expect(openRes.status).toBe(201);
    const sessionId = openRes.body.data.id;

    const secondOpen = await request(app)
      .post('/api/cash-sessions/open')
      .set('Authorization', `Bearer ${token}`)
      .send({ openingAmount: 1000 });
    expect(secondOpen.status).toBe(409);

    const saleRes = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: product.id, quantity: 1 }], payments: [{ method: 'cash', amount: product.sell_price }] });
    expect(saleRes.status).toBe(201);
    expect(saleRes.body.data.cash_session_id).toBe(sessionId);
  });

  it('computes expected cash as opening float + cash sales, and closes correctly', async () => {
    const current = await request(app).get('/api/cash-sessions/current').set('Authorization', `Bearer ${token}`);
    const sessionId = current.body.data.id;

    // One cash sale of product.sell_price already happened in the previous test.
    const expected = 5000 + product.sell_price;

    const closeRes = await request(app)
      .post(`/api/cash-sessions/${sessionId}/close`)
      .set('Authorization', `Bearer ${token}`)
      .send({ closingAmount: expected }); // counted the drawer, it matches
    expect(closeRes.status).toBe(200);
    expect(closeRes.body.data.expected_amount).toBe(expected);
    expect(closeRes.body.data.closing_amount).toBe(expected);

    // No longer the "current" open session.
    const afterClose = await request(app).get('/api/cash-sessions/current').set('Authorization', `Bearer ${token}`);
    expect(afterClose.body.data).toBeNull();
  });

  it('a split cash+card sale only counts its cash portion toward expected cash', async () => {
    await request(app).post('/api/cash-sessions/open').set('Authorization', `Bearer ${token}`).send({ openingAmount: 1000 });

    const half = Math.round((product.sell_price / 2) * 100) / 100;
    const other = product.sell_price - half;
    await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({
        items: [{ product_id: product.id, quantity: 1 }],
        payments: [{ method: 'cash', amount: half }, { method: 'card', amount: other }],
      });

    const current = await request(app).get('/api/cash-sessions/current').set('Authorization', `Bearer ${token}`);
    const closeRes = await request(app)
      .post(`/api/cash-sessions/${current.body.data.id}/close`)
      .set('Authorization', `Bearer ${token}`)
      .send({ closingAmount: 1000 + half });
    // Only the cash half counted — not the full sale total.
    expect(closeRes.body.data.expected_amount).toBe(1000 + half);
  });

  it('refuses to close an already-closed session', async () => {
    const openRes = await request(app).post('/api/cash-sessions/open').set('Authorization', `Bearer ${token}`).send({ openingAmount: 500 });
    const sessionId = openRes.body.data.id;

    await request(app).post(`/api/cash-sessions/${sessionId}/close`).set('Authorization', `Bearer ${token}`).send({ closingAmount: 500 });
    const secondClose = await request(app).post(`/api/cash-sessions/${sessionId}/close`).set('Authorization', `Bearer ${token}`).send({ closingAmount: 500 });
    expect(secondClose.status).toBe(409);
  });
});
