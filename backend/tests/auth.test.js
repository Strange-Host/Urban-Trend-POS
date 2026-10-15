const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

afterAll(() => cleanupTestDb());

describe('auth', () => {
  it('logs in with the seeded admin credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@urbantrends.com', password: 'ChangeMe123!' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it('is case-insensitive on email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'Admin@UrbanTrends.com', password: 'ChangeMe123!' });
    expect(res.status).toBe(200);
  });

  it('rejects a wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@urbantrends.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('rejects requests with no token', async () => {
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(401);
  });

  it('revokes an outstanding token immediately on deactivation, before it would naturally expire', async () => {
    const adminToken = await loginAsAdmin();

    const createRes = await request(app)
      .post('/api/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Revoke Test', email: 'revoke-test@urbantrends.com', phone: '0700000001', password: 'RevokeTest123!', role: 'cashier' });
    expect(createRes.status).toBe(201);
    const staffId = createRes.body.data.id;

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'revoke-test@urbantrends.com', password: 'RevokeTest123!' });
    const staffToken = loginRes.body.token;

    // Token works before deactivation.
    const beforeRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${staffToken}`);
    expect(beforeRes.status).toBe(200);

    const deactivateRes = await request(app)
      .delete(`/api/staff/${staffId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(deactivateRes.status).toBe(204);

    // Same still-unexpired token now rejected.
    const afterRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${staffToken}`);
    expect(afterRes.status).toBe(401);
  });
});
