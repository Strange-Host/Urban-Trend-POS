const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let adminToken;
let repId;
let repToken;
let product;
let today;

beforeAll(async () => {
  adminToken = await loginAsAdmin();

  const createRep = await request(app).post('/api/staff').set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Payroll Rep', email: 'payrollrep@urbantrends.com', phone: '0722100001', password: 'RepPass123!', role: 'cashier' });
  repId = createRep.body.data.id;

  const repLogin = await request(app).post('/api/auth/login').send({ email: 'payrollrep@urbantrends.com', password: 'RepPass123!' });
  repToken = repLogin.body.token;
  await request(app).post('/api/attendance/clock-in').set('Authorization', `Bearer ${repToken}`);

  const productsRes = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${adminToken}`);
  product = productsRes.body.data[0];

  const todayRes = await request(app).get('/api/attendance/today').set('Authorization', `Bearer ${adminToken}`);
  today = require('../src/utils/storeTime').localDate(); // the shop's day, not the UTC date
});

afterAll(() => cleanupTestDb());

async function createPaidOrderForRep(phone, quantity) {
  const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Payroll Order', phone, payment_type: 'prepaid', assigned_staff_id: repId, items: [{ product_id: product.id, quantity }] });
  const orderId = createRes.body.data.id;
  await request(app).post(`/api/orders/${orderId}/dispatch`).set('Authorization', `Bearer ${adminToken}`);
  const total = createRes.body.data.total;
  await request(app).post(`/api/orders/${orderId}/payments`).set('Authorization', `Bearer ${adminToken}`)
    .send({ method: 'mobile_money', amount: total, reference: 'TXN1' });
  return { orderId, total };
}

describe('payroll (Phase 6)', () => {
  it('requires staff_id/from/to', async () => {
    const res = await request(app).get('/api/payroll/summary').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('counts a daily retainer for each day the rep logged in', async () => {
    const res = await request(app).get(`/api/payroll/summary?staff_id=${repId}&from=${today}&to=${today}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.dailyRetainer.daysLoggedIn).toBe(1);
    expect(res.body.data.dailyRetainer.total).toBe(30000); // KSh 300 in cents
  });

  it('includes commission for dispatched-paid orders assigned to the rep', async () => {
    const { total } = await createPaidOrderForRep('0733200001', 2);
    const res = await request(app).get(`/api/payroll/summary?staff_id=${repId}&from=${today}&to=${today}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.data.commission.unitsSold).toBeGreaterThanOrEqual(2);
    expect(res.body.data.commission.achievedSales).toBeGreaterThanOrEqual(total);
    expect(res.body.data.commission.commissionTotal).toBeGreaterThan(0);
  });

  it('a salary-advance requisition, once approved, reduces net payable', async () => {
    const beforeRes = await request(app).get(`/api/payroll/summary?staff_id=${repId}&from=${today}&to=${today}`).set('Authorization', `Bearer ${adminToken}`);
    const netBefore = beforeRes.body.data.netPayable;

    // The advance is deducted from whoever REQUESTED it, so the rep has to be
    // the requester (this used to be filed by the admin, which only ever
    // reduced the admin's own pay and left the rep's summary unchanged).
    const reqRes = await request(app).post('/api/requisitions').set('Authorization', `Bearer ${repToken}`)
      .send({ type: 'salary_advance', amount: 100000, notes: 'Emergency advance' });
    expect(reqRes.status).toBe(201);
    expect(reqRes.body.data.type).toBe('salary_advance');

    const approveRes = await request(app).patch(`/api/requisitions/${reqRes.body.data.id}/approve`).set('Authorization', `Bearer ${adminToken}`).send({});
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe('approved');

    const afterRes = await request(app).get(`/api/payroll/summary?staff_id=${repId}&from=${today}&to=${today}`).set('Authorization', `Bearer ${adminToken}`);
    expect(afterRes.body.data.adjustmentsTotal).toBeGreaterThanOrEqual(100000);
    expect(afterRes.body.data.netPayable).toBe(netBefore - 100000);
  });

  it('records a standalone loss deduction that also reduces net payable', async () => {
    const beforeRes = await request(app).get(`/api/payroll/summary?staff_id=${repId}&from=${today}&to=${today}`).set('Authorization', `Bearer ${adminToken}`);
    const netBefore = beforeRes.body.data.netPayable;

    const lossRes = await request(app).post('/api/payroll/loss-deduction').set('Authorization', `Bearer ${adminToken}`)
      .send({ staff_id: repId, amount: 20000, notes: 'Till shortfall' });
    expect(lossRes.status).toBe(201);
    expect(lossRes.body.data.type).toBe('loss_deduction');

    const afterRes = await request(app).get(`/api/payroll/summary?staff_id=${repId}&from=${today}&to=${today}`).set('Authorization', `Bearer ${adminToken}`);
    expect(afterRes.body.data.netPayable).toBe(netBefore - 20000);
  });
});
