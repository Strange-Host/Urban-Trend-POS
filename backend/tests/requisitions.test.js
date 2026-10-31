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
      .send({ signed_name: 'Store Admin', items: [{ product_id: product.id, quantity_requested: 10 }] });
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
      .send({ signed_name: 'Store Admin', items: [{ product_id: product.id, quantity_requested: 20 }] });
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
      .send({ signed_name: 'Store Admin', items: [{ product_id: product.id, quantity_requested: 1 }] });
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

describe('requisitions flowing into Expenditure', () => {
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const make = async (qty) => {
    const r = await request(app).post('/api/requisitions').set(auth())
      .send({ signed_name: 'Store Admin', notes: 'for the shop', items: [{ product_id: product.id, quantity_requested: qty }] });
    return r.body.data.id;
  };
  const expenseFor = async (requisitionId) => {
    const res = await request(app).get('/api/expenses?limit=100').set(auth());
    return res.body.data.filter((e) => e.requisition_id === requisitionId);
  };

  it('approving a shop requisition creates one linked, approved expense for approved qty × cost price', async () => {
    const db = require('../src/config/db');
    const { cost_price } = db.prepare('SELECT cost_price FROM products WHERE id = ?').get(product.id);
    const id = await make(10);
    const res = await request(app).patch(`/api/requisitions/${id}/approve`).set(auth())
      .send({ items: [{ product_id: product.id, quantity_approved: 4 }] });
    expect(res.status).toBe(200);

    const linked = await expenseFor(id);
    expect(linked).toHaveLength(1);
    expect(linked[0].amount).toBe(4 * cost_price);
    expect(linked[0].status).toBe('approved');
    expect(linked[0].category_name).toBe('Shop Requisitions');
  });

  it('a rejected requisition creates no expense', async () => {
    const id = await make(2);
    await request(app).patch(`/api/requisitions/${id}/reject`).set(auth()).send({ rejection_reason: 'no' });
    expect(await expenseFor(id)).toHaveLength(0);
  });

  it('a salary advance is not forwarded to Expenditure', async () => {
    const created = await request(app).post('/api/requisitions').set(auth())
      .send({ type: 'salary_advance', amount: 100000, signed_name: 'Store Admin' });
    const id = created.body.data.id;
    const res = await request(app).patch(`/api/requisitions/${id}/approve`).set(auth()).send({});
    expect(res.status).toBe(200);
    expect(await expenseFor(id)).toHaveLength(0);
  });

  it('the database refuses a second expense for the same requisition', async () => {
    const db = require('../src/config/db');
    const id = await make(1);
    await request(app).patch(`/api/requisitions/${id}/approve`).set(auth()).send({});
    const row = db.prepare('SELECT * FROM expenses WHERE requisition_id = ?').get(id);
    expect(() => db.prepare(`INSERT INTO expenses (store_id, category_id, amount, expense_date, recorded_by_staff_id, requisition_id)
      VALUES (?, ?, 1, '2026-01-01', ?, ?)`).run(row.store_id, row.category_id, row.recorded_by_staff_id, id)).toThrow();
  });
});
