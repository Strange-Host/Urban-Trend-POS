const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let token;
let product;
let repId;
let today;

beforeAll(async () => {
  token = await loginAsAdmin();
  const productsRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
  product = productsRes.body.data[0];

  const createRep = await request(app).post('/api/staff').set('Authorization', `Bearer ${token}`)
    .send({ name: 'Report Rep', email: 'reportrep@urbantrends.com', phone: '0722200001', password: 'RepPass123!', role: 'cashier' });
  repId = createRep.body.data.id;
  const repLogin = await request(app).post('/api/auth/login').send({ email: 'reportrep@urbantrends.com', password: 'RepPass123!' });
  await request(app).post('/api/attendance/clock-in').set('Authorization', `Bearer ${repLogin.body.token}`);

  today = require('../src/utils/storeTime').localDate(); // the shop's day, not the UTC date

  // A dispatched-and-paid order today, assigned to the rep.
  const orderRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ name: 'Report Customer', phone: '0733300001', payment_type: 'prepaid', assigned_staff_id: repId, items: [{ product_id: product.id, quantity: 2 }] });
  const orderId = orderRes.body.data.id;
  await request(app).post(`/api/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${token}`);
  await request(app).post(`/api/orders/${orderId}/payments`).set('Authorization', `Bearer ${token}`)
    .send({ method: 'mobile_money', amount: orderRes.body.data.total, reference: 'TXN-REPORT-1' });

  // A dispatched-but-unpaid COD order (capital tied up).
  const unpaidRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ name: 'Unpaid Customer', phone: '0733300002', city: 'Nairobi', items: [{ product_id: product.id, quantity: 1 }] });
  await request(app).post(`/api/orders/${unpaidRes.body.data.id}/confirm-cod`).set('Authorization', `Bearer ${token}`);
  await request(app).post(`/api/orders/${unpaidRes.body.data.id}/dispatch`).set('Authorization', `Bearer ${token}`);
});

afterAll(() => cleanupTestDb());

describe('reporting (Phase 9)', () => {
  it('dashboard-overview combines POS + online revenue and flags unpaid parcels by courier', async () => {
    const res = await request(app).get(`/api/reports/dashboard-overview?date=${today}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.salesToday.onlineRevenue).toBeGreaterThan(0);
    expect(res.body.data.unpaidParcelsByCourier.length).toBeGreaterThan(0);
    const totalTiedUp = res.body.data.unpaidParcelsByCourier.reduce((sum, row) => sum + row.capital_tied_up, 0);
    expect(totalTiedUp).toBeGreaterThan(0);
    expect(res.body.data.stockOnHand).toHaveProperty('total_cost_value');
  });

  it('unpaid-parcels lists the dispatched-but-unpaid order with courier and customer detail', async () => {
    const res = await request(app).get('/api/reports/unpaid-parcels').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.some((row) => row.customer_phone === '0733300002')).toBe(true);
  });

  it('profit-summary computes revenue, cost of goods sold, delivery, labor, expenses, and net profit', async () => {
    const res = await request(app).get(`/api/reports/profit-summary?from=${today}&to=${today}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.revenue).toBeGreaterThan(0);
    expect(d.costOfGoodsSold).toBeGreaterThan(0);
    expect(d.grossMargin).toBe(d.revenue - d.costOfGoodsSold);
    expect(d.netProfit).toBe(d.revenue - d.costOfGoodsSold - d.deliveryFees - d.laborCost - d.businessExpenses);
  });

  it('top-products-by-profit and top-staff-by-profit return ranked rows', async () => {
    const productsRes = await request(app).get(`/api/reports/top-products-by-profit?from=${today}&to=${today}`).set('Authorization', `Bearer ${token}`);
    expect(productsRes.status).toBe(200);
    expect(productsRes.body.data.length).toBeGreaterThan(0);
    expect(productsRes.body.data[0]).toHaveProperty('profit');

    const staffRes = await request(app).get(`/api/reports/top-staff-by-profit?from=${today}&to=${today}`).set('Authorization', `Bearer ${token}`);
    expect(staffRes.status).toBe(200);
    expect(staffRes.body.data.some((row) => row.staff_id === repId)).toBe(true);
  });
});
