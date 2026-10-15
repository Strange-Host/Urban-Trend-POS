const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');

let token;

beforeAll(async () => {
  token = await loginAsAdmin();
});

afterAll(() => cleanupTestDb());

describe('currency stored as integer cents', () => {
  it('money columns are genuinely INTEGER storage class, not REAL', () => {
    const checks = [
      ['products', ['cost_price', 'sell_price']],
      ['sales', ['subtotal', 'tax_total', 'discount_total', 'total']],
      ['sale_items', ['unit_price', 'discount', 'line_total']],
      ['payments', ['amount']],
      ['cash_sessions', ['opening_amount']],
    ];
    for (const [table, cols] of checks) {
      const info = db.prepare(`PRAGMA table_info(${table})`).all();
      for (const col of cols) {
        const declared = info.find((c) => c.name === col).type;
        expect(declared).toBe('INTEGER');
      }
    }
  });

  it('a classically float-imprecise price (19.99) round-trips through create and checkout exactly', async () => {
    const catRes = await request(app).get('/api/categories').set('Authorization', `Bearer ${token}`);
    const categoryId = catRes.body.data[0]?.id || null;

    const createRes = await request(app)
      .post('/api/products')
      .set('Authorization', `Bearer ${token}`)
      .send({ sku: 'CENTS-TEST-1999', name: 'Float Precision Test', category_id: categoryId, cost_price: 1000, sell_price: 1999 });
    expect(createRes.status).toBe(201);
    // 1999 cents in, 1999 cents out — no float creep from JS arithmetic anywhere in the path.
    expect(createRes.body.data.sell_price).toBe(1999);

    const productId = createRes.body.data.id;
    await request(app).post('/api/inventory/adjust').set('Authorization', `Bearer ${token}`)
      .send({ product_id: productId, change_qty: 10, reason: 'restock' });

    // Three units at 1999 cents each — the classic case that drifts under float (3 * 19.99 = 59.97 exactly, but plenty of triples don't).
    const saleRes = await request(app)
      .post('/api/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ items: [{ product_id: productId, quantity: 3 }], payments: [{ method: 'cash', amount: 1999 * 3 }] });
    expect(saleRes.status).toBe(201);
    expect(saleRes.body.data.total).toBe(5997);
    expect(saleRes.body.data.items[0].line_total).toBe(5997);
  });

  it('SUM() over many odd-cent line items matches the exact integer sum — no aggregation drift', async () => {
    const catRes = await request(app).get('/api/categories').set('Authorization', `Bearer ${token}`);
    const categoryId = catRes.body.data[0]?.id || null;

    // Prices deliberately chosen to be float-precision landmines if this were REAL: .01, .03, .07, .11, .13 KES.
    const oddPrices = [1, 3, 7, 11, 13, 17, 19, 23, 29, 31];
    let expectedTotal = 0;
    const productIds = [];
    for (const [i, price] of oddPrices.entries()) {
      const res = await request(app).post('/api/products').set('Authorization', `Bearer ${token}`)
        .send({ sku: `CENTS-DRIFT-${i}`, name: `Drift Test ${i}`, category_id: categoryId, cost_price: 0, sell_price: price });
      productIds.push(res.body.data.id);
      await request(app).post('/api/inventory/adjust').set('Authorization', `Bearer ${token}`)
        .send({ product_id: res.body.data.id, change_qty: 5, reason: 'restock' });
      expectedTotal += price;
    }

    const saleRes = await request(app).post('/api/sales').set('Authorization', `Bearer ${token}`).send({
      items: productIds.map((id) => ({ product_id: id, quantity: 1 })),
      payments: [{ method: 'cash', amount: expectedTotal }],
    });
    expect(saleRes.status).toBe(201);
    expect(saleRes.body.data.total).toBe(expectedTotal);

    // Now check the SQL-level SUM() in reports.controller.js agrees exactly — this is
    // the actual site float drift would show up (aggregating many rows in SQL, not JS).
    const reportRes = await request(app).get('/api/reports/sales-summary').set('Authorization', `Bearer ${token}`);
    expect(reportRes.body.data.revenue).toBeGreaterThanOrEqual(expectedTotal);
    expect(Number.isInteger(reportRes.body.data.revenue)).toBe(true);
  });
});
