const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let token;

beforeAll(async () => {
  token = await loginAsAdmin();
});

afterAll(() => cleanupTestDb());

describe('staff (users)', () => {
  it('creates a staff member and lists them', async () => {
    const createRes = await request(app).post('/api/staff').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Staff List Test', email: 'staff-list-test@urbantrends.com', phone: '0711000001', password: 'ListTest123!', role: 'cashier' });
    expect(createRes.status).toBe(201);
    expect(createRes.body.data.password_hash).toBeUndefined(); // never leaked

    const listRes = await request(app).get('/api/staff?search=Staff List Test').set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.some((u) => u.id === createRes.body.data.id)).toBe(true);
  });

  it('rejects creating a staff member with an unknown role', async () => {
    const res = await request(app).post('/api/staff').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad Role', email: 'bad-role@urbantrends.com', phone: '0711000002', password: 'BadRole123!', role: 'superadmin' });
    expect(res.status).toBe(400);
  });

  it('gets a single staff member by id', async () => {
    const createRes = await request(app).post('/api/staff').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Get By Id Test', email: 'get-by-id@urbantrends.com', phone: '0711000003', password: 'GetById123!', role: 'cashier' });

    const getRes = await request(app).get(`/api/staff/${createRes.body.data.id}`).set('Authorization', `Bearer ${token}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.name).toBe('Get By Id Test');
  });

  it('404s for an unknown staff id', async () => {
    const res = await request(app).get('/api/staff/999999').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('updates a field without a password change and does NOT revoke tokens', async () => {
    const createRes = await request(app).post('/api/staff').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Update Test', email: 'update-test@urbantrends.com', phone: '0711000004', password: 'UpdateTest123!', role: 'cashier' });
    const staffId = createRes.body.data.id;

    const staffLogin = await request(app).post('/api/auth/login').send({ email: 'update-test@urbantrends.com', password: 'UpdateTest123!' });
    const staffToken = staffLogin.body.token;

    const updateRes = await request(app).patch(`/api/staff/${staffId}`).set('Authorization', `Bearer ${token}`)
      .send({ name: 'Update Test Renamed' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.name).toBe('Update Test Renamed');

    // A plain field edit (no password/deactivation) shouldn't have revoked
    // the existing session — this is the exact distinction the
    // revokesToken logic in users.service.js is responsible for getting right.
    const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${staffToken}`);
    expect(meRes.status).toBe(200);
  });

  it('admin password reset revokes the existing session and returns a one-time temp password', async () => {
    const createRes = await request(app).post('/api/staff').set('Authorization', `Bearer ${token}`)
      .send({ name: 'Reset Test', email: 'reset-test@urbantrends.com', phone: '0711000005', password: 'ResetTest123!', role: 'cashier' });
    const staffId = createRes.body.data.id;

    const staffLogin = await request(app).post('/api/auth/login').send({ email: 'reset-test@urbantrends.com', password: 'ResetTest123!' });
    const staffToken = staffLogin.body.token;

    const resetRes = await request(app).post(`/api/staff/${staffId}/reset-password`).set('Authorization', `Bearer ${token}`);
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.data.temporaryPassword).toBeTruthy();

    const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${staffToken}`);
    expect(meRes.status).toBe(401);

    // The returned temp password actually works.
    const newLogin = await request(app).post('/api/auth/login').send({ email: 'reset-test@urbantrends.com', password: resetRes.body.data.temporaryPassword });
    expect(newLogin.status).toBe(200);
  });

  it('refuses to let an admin deactivate their own account', async () => {
    const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    const res = await request(app).delete(`/api/staff/${meRes.body.user.id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});
