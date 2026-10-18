const { app, request, extractRefreshCookie, cleanupTestDb } = require('./setup');

afterAll(() => cleanupTestDb());

describe('refresh tokens', () => {
  it('login sets an httpOnly refresh token cookie and returns an access token in the body', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'admin@urbantrends.com', password: 'ChangeMe123!' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.refreshToken).toBeUndefined(); // must NOT be in the body — cookie only

    const setCookie = res.headers['set-cookie'].find((c) => c.startsWith('ut_refresh_token='));
    expect(setCookie).toBeTruthy();
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/api\/auth/i);
  });

  it('exchanges the refresh cookie for a new access token and a rotated refresh cookie', async () => {
    const loginRes = await request(app).post('/api/auth/login').send({ email: 'admin@urbantrends.com', password: 'ChangeMe123!' });
    const cookie = extractRefreshCookie(loginRes);

    const refreshRes = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.token).toBeTruthy();

    const newCookie = extractRefreshCookie(refreshRes);
    expect(newCookie).toBeTruthy();
    expect(newCookie).not.toBe(cookie); // rotated, not reused

    // New access token actually works.
    const meRes = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${refreshRes.body.token}`);
    expect(meRes.status).toBe(200);
  });

  it('a refresh token can only be used once — reusing it after rotation is rejected', async () => {
    const loginRes = await request(app).post('/api/auth/login').send({ email: 'admin@urbantrends.com', password: 'ChangeMe123!' });
    const cookie = extractRefreshCookie(loginRes);

    const first = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(first.status).toBe(200);

    const reuse = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(reuse.status).toBe(401);
  });

  it('rejects a request with no refresh cookie at all', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
  });

  it('rejects a garbage/unknown refresh cookie', async () => {
    const res = await request(app).post('/api/auth/refresh').set('Cookie', 'ut_refresh_token=not-a-real-token');
    expect(res.status).toBe(401);
  });

  it('logout revokes the refresh token and clears the cookie', async () => {
    const loginRes = await request(app).post('/api/auth/login').send({ email: 'admin@urbantrends.com', password: 'ChangeMe123!' });
    const cookie = extractRefreshCookie(loginRes);

    const logoutRes = await request(app).post('/api/auth/logout').set('Cookie', cookie);
    expect(logoutRes.status).toBe(204);
    const clearedCookie = logoutRes.headers['set-cookie']?.find((c) => c.startsWith('ut_refresh_token='));
    expect(clearedCookie).toMatch(/ut_refresh_token=;/); // cleared — empty value

    const refreshAfterLogout = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    expect(refreshAfterLogout.status).toBe(401);
  });

  it('deactivating a user revokes their outstanding refresh tokens too, not just the access token', async () => {
    const adminLogin = await request(app).post('/api/auth/login').send({ email: 'admin@urbantrends.com', password: 'ChangeMe123!' });
    const adminToken = adminLogin.body.token;

    const createRes = await request(app)
      .post('/api/staff')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Refresh Revoke Test', email: 'refresh-revoke@urbantrends.com', phone: '0700000002', password: 'Copper-Lantern-7115', role: 'cashier' });
    const staffId = createRes.body.data.id;

    const staffLogin = await request(app).post('/api/auth/login').send({ email: 'refresh-revoke@urbantrends.com', password: 'Copper-Lantern-7115' });
    const staffCookie = extractRefreshCookie(staffLogin);

    await request(app).delete(`/api/staff/${staffId}`).set('Authorization', `Bearer ${adminToken}`);

    const refreshAfterDeactivation = await request(app).post('/api/auth/refresh').set('Cookie', staffCookie);
    expect(refreshAfterDeactivation.status).toBe(401);
  });
});
