const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');

let adminToken;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const creds = { environment: 'sandbox', mpesa_shortcode: '600988', mpesa_consumer_key: 'ck-secret-value', mpesa_consumer_secret: 'cs-secret-value', mpesa_passkey: 'pk-secret-value' };

beforeAll(async () => { adminToken = await loginAsAdmin(); });
afterAll(() => cleanupTestDb());

describe('payment gateway list, switch-off and switch-on', () => {
  it('lists a configured gateway with flags only, never a secret value', async () => {
    await request(app).put('/api/settings/payment-gateways/mpesa').set(auth(adminToken)).send(creds).expect(200);
    const res = await request(app).get('/api/settings/payment-gateways').set(auth(adminToken));
    expect(res.status).toBe(200);
    const row = res.body.data.find((g) => g.provider === 'mpesa');
    expect(row.is_active).toBe(1);
    expect(row.has_mpesa_consumer_secret).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/secret-value|pk-secret/);
  });

  it('switches a gateway off with DELETE and back on by saving it again', async () => {
    const off = await request(app).delete('/api/settings/payment-gateways/mpesa').set(auth(adminToken));
    expect(off.status).toBe(200);
    expect(off.body.data.is_active).toBe(0);

    const on = await request(app).put('/api/settings/payment-gateways/mpesa').set(auth(adminToken)).send({ environment: 'sandbox' });
    expect(on.status).toBe(200);
    expect(on.body.data.is_active).toBe(1);
    expect(on.body.data.has_mpesa_consumer_secret).toBe(true);   // the saved secrets were kept
  });

  it('404s when switching off a gateway that was never set up', async () => {
    const res = await request(app).delete('/api/settings/payment-gateways/kcb').set(auth(adminToken));
    expect(res.status).toBe(404);
  });

  it('is admin-only', async () => {
    const res = await request(app).get('/api/settings/payment-gateways');
    expect(res.status).toBe(401);
  });
});
