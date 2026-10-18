const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

let token;
let product;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  token = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=1').set(auth());
  product = res.body.data[0];
});

afterAll(() => cleanupTestDb());

let phoneCounter = 0;
const nextPhone = () => `07440${String(10000 + phoneCounter++)}`;

describe('discount caps (server-side)', () => {
  const price = () => product.sell_price;

  it('checkout: a line discount larger than the line is rejected', async () => {
    const res = await request(app).post('/api/sales').set(auth()).send({
      items: [{ product_id: product.id, quantity: 1, discount: price() + 1 }],
      payments: [{ method: 'cash', amount: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/cannot be more than the line value/i);
  });

  it('checkout: a sale discount larger than the sale is rejected', async () => {
    const res = await request(app).post('/api/sales').set(auth()).send({
      items: [{ product_id: product.id, quantity: 1 }],
      discountTotal: price() + 1,
      payments: [{ method: 'cash', amount: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/cannot be more than the sale value/i);
  });

  it('checkout: the sale discount is capped against the subtotal AFTER line discounts', async () => {
    const lineDiscount = Math.floor(price() / 2);
    const afterLine = price() - lineDiscount;
    const res = await request(app).post('/api/sales').set(auth()).send({
      items: [{ product_id: product.id, quantity: 1, discount: lineDiscount }],
      discountTotal: afterLine + 1,
      payments: [{ method: 'cash', amount: 1 }],
    });
    expect(res.status).toBe(400);
    // Assert the cap message itself: a payment-mismatch 400 would also pass a bare status check.
    expect(res.body.error.message).toMatch(/cannot be more than the sale value/i);
  });

  it('checkout: a rejected discount leaves no sale and no stock movement behind', async () => {
    const salesBefore = db.prepare('SELECT COUNT(*) AS n FROM sales').get().n;
    const stockBefore = db.prepare('SELECT SUM(quantity) AS q FROM inventory WHERE product_id = ?').get(product.id).q;
    const rejected = await request(app).post('/api/sales').set(auth()).send({
      items: [{ product_id: product.id, quantity: 1, discount: price() + 1 }],
      payments: [{ method: 'cash', amount: 1 }],
    });
    expect(rejected.body.error.message).toMatch(/cannot be more than the line value/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sales').get().n).toBe(salesBefore);
    expect(db.prepare('SELECT SUM(quantity) AS q FROM inventory WHERE product_id = ?').get(product.id).q).toBe(stockBefore);
  });

  it('checkout: discounts at or under the caps still work', async () => {
    const lineDiscount = Math.floor(price() / 4);
    const saleDiscount = Math.floor(price() / 4);
    const expectedTotal = price() - lineDiscount - saleDiscount;
    const res = await request(app).post('/api/sales').set(auth()).send({
      items: [{ product_id: product.id, quantity: 1, discount: lineDiscount }],
      discountTotal: saleDiscount,
      payments: [{ method: 'cash', amount: expectedTotal }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.total).toBe(expectedTotal);
  });

  it('checkout: a discount equal to the full line value is allowed (not over the cap)', async () => {
    // Nothing left to pay is a separate rule (payments must be positive); here we only prove the cap is "more than", not "at least".
    const res = await request(app).post('/api/sales').set(auth()).send({
      items: [{ product_id: product.id, quantity: 1, discount: price() }],
      payments: [{ method: 'cash', amount: 1 }],
    });
    expect(res.body.error?.message || '').not.toMatch(/cannot be more than/i);
  });

  it('orders: line and order discounts are capped the same way', async () => {
    const lineRes = await request(app).post('/api/orders').set(auth()).send({
      name: 'Cap Test', phone: nextPhone(), items: [{ product_id: product.id, quantity: 2, discount: price() * 2 + 1 }],
    });
    expect(lineRes.status).toBe(400);

    const orderRes = await request(app).post('/api/orders').set(auth()).send({
      name: 'Cap Test', phone: nextPhone(), items: [{ product_id: product.id, quantity: 1 }], discount_total: price() + 1,
    });
    expect(orderRes.status).toBe(400);

    const okRes = await request(app).post('/api/orders').set(auth()).send({
      name: 'Cap Test OK', phone: nextPhone(), items: [{ product_id: product.id, quantity: 1, discount: 1 }], discount_total: 1,
    });
    expect(okRes.status).toBe(201);
    expect(okRes.body.data.total).toBe(price() - 2);
  });

  it('orders: merging items enforces the line cap too', async () => {
    const phone = nextPhone();
    const first = await request(app).post('/api/orders').set(auth())
      .send({ name: 'Merge Cap', phone, items: [{ product_id: product.id, quantity: 1 }] });
    expect(first.status).toBe(201);
    const res = await request(app).post(`/api/orders/${first.body.data.id}/merge-items`).set(auth())
      .send({ items: [{ product_id: product.id, quantity: 1, discount: price() + 1 }] });
    expect(res.status).toBe(400);
  });
});
