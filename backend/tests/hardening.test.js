const jwt = require('jsonwebtoken');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

afterAll(() => cleanupTestDb());

describe('webhook ingress', () => {
  it('refuses a body over the cap before any signature work, but lets a normal one through to the signature check', async () => {
    const big = JSON.stringify({ filler: 'x'.repeat(3 * 1024 * 1024) });                       // ~3 MB: over the 2 MB default
    const tooBig = await request(app).post('/api/integrations/webhooks/shopify').set('Content-Type', 'application/json').send(big);
    expect(tooBig.status).toBe(413);

    const normal = await request(app).post('/api/integrations/webhooks/shopify').set('Content-Type', 'application/json')
      .send(JSON.stringify({ id: 1, filler: 'x'.repeat(100 * 1024) }));
    expect(normal.status).not.toBe(413);                                                         // reached the route (and was rejected there)
  });
});

describe('refresh cookie', () => {
  const login = (headers = {}) => request(app).post('/api/auth/login').set(headers).send({ email: 'admin@urbantrends.com', password: 'ChangeMe123!' });
  const cookieOf = (res) => (res.headers['set-cookie'] || []).find((c) => c.startsWith('ut_refresh_token=')) || '';

  it('is marked Secure when the request arrived over HTTPS even if NODE_ENV was never set to production', async () => {
    expect(process.env.NODE_ENV).not.toBe('production');
    const res = await login({ 'X-Forwarded-Proto': 'https' });
    expect(res.status).toBe(200);
    expect(cookieOf(res)).toMatch(/;\s*Secure/i);
    expect(cookieOf(res)).toMatch(/HttpOnly/i);
  });

  it('is not Secure over plain HTTP in development (so local http:// use keeps working)', async () => {
    const res = await login();
    expect(cookieOf(res)).not.toMatch(/;\s*Secure/i);
  });
});

describe('access token algorithm', () => {
  it('accepts the server\'s HS256 token and rejects one signed with another algorithm, even with the right secret', async () => {
    const good = await loginAsAdmin();
    const payload = jwt.decode(good);
    const other = jwt.sign({ id: payload.id, role: payload.role, storeId: payload.storeId, name: payload.name,
      tokenVersion: payload.tokenVersion, sid: payload.sid }, process.env.JWT_SECRET, { algorithm: 'HS512', expiresIn: '5m' });

    const ok = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${good}`);
    const bad = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${other}`);
    expect(ok.status).toBe(200);
    expect(bad.status).toBe(401);
  });
});

describe('body-parser errors are the caller\'s fault, not a 500', () => {
  it('reports malformed JSON as 400 and an over-limit body as 413', async () => {
    const garbled = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email": ');
    expect(garbled.status).toBe(400);
    expect(garbled.body.error.code).toBe('BAD_REQUEST');

    const huge = await request(app).post('/api/auth/login').set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'x', password: 'y'.repeat(2 * 1024 * 1024) }));   // over the general 1 MB limit
    expect(huge.status).toBe(413);
  });
});
