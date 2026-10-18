const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let adminToken;
let repAToken;
let repBId;

beforeAll(async () => {
  adminToken = await loginAsAdmin();

  const createRepA = await request(app).post('/api/staff').set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Rep A', email: 'repa@urbantrends.com', phone: '0722000001', password: 'Quartz-Meadow-7421', role: 'cashier' });
  const loginA = await request(app).post('/api/auth/login').send({ email: 'repa@urbantrends.com', password: 'Quartz-Meadow-7421' });
  repAToken = loginA.body.token;

  const createRepB = await request(app).post('/api/staff').set('Authorization', `Bearer ${adminToken}`)
    .send({ name: 'Rep B', email: 'repb@urbantrends.com', phone: '0722000002', password: 'Quartz-Meadow-7421', role: 'cashier' });
  repBId = createRepB.body.data.id;
});

afterAll(() => cleanupTestDb());

describe('attendance (Phase 5)', () => {
  it('clocks in and out, and rejects a duplicate clock-in the same day', async () => {
    const inRes = await request(app).post('/api/attendance/clock-in').set('Authorization', `Bearer ${repAToken}`);
    expect(inRes.status).toBe(201);
    expect(inRes.body.data.clock_in_at).toBeTruthy();

    const dupInRes = await request(app).post('/api/attendance/clock-in').set('Authorization', `Bearer ${repAToken}`);
    expect(dupInRes.status).toBe(409);

    const outRes = await request(app).post('/api/attendance/clock-out').set('Authorization', `Bearer ${repAToken}`);
    expect(outRes.status).toBe(200);
    expect(outRes.body.data.clock_out_at).toBeTruthy();
  });

  it('lists absences for staff who never clocked in today', async () => {
    const res = await request(app).get('/api/attendance/absences-today').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    // Rep B never clocked in in this suite — should show up as absent.
    expect(res.body.data.some((row) => row.staff_id === repBId && !row.clock_in_at)).toBe(true);
  });
});

describe('telesales distribution (Phase 5)', () => {
  it('auto-assigns a new lead to the only currently-eligible (clocked-in) rep', async () => {
    // Rep A clocked in (and back out) above; Rep B never clocked in — only Rep A is eligible.
    const res = await request(app).post('/api/leads').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Auto Assign Test', phone: '0733100001', source: 'whatsapp' });
    expect(res.status).toBe(201);
    expect(res.body.data.assigned_staff_id).not.toBeNull();
    expect(res.body.data.assigned_staff_id).not.toBe(repBId); // Rep B was never eligible
  });

  it('does not override an explicitly-assigned staff member', async () => {
    const res = await request(app).post('/api/leads').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Explicit Assign Test', phone: '0733100002', source: 'whatsapp', assigned_staff_id: repBId });
    expect(res.status).toBe(201);
    expect(res.body.data.assigned_staff_id).toBe(repBId);
  });

  it('rebalance sweep is admin-only and returns a report shape', async () => {
    const res = await request(app).post('/api/telesales/rebalance').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('leads');
    expect(res.body.data).toHaveProperty('orders');

    const forbiddenRes = await request(app).post('/api/telesales/rebalance').set('Authorization', `Bearer ${repAToken}`);
    expect(forbiddenRes.status).toBe(403);
  });
});
