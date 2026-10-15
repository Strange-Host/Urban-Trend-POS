process.env.PAYMENT_WEBHOOK_SECRET = 'global-test-webhook-secret';

const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const mpesaClient = require('../src/config/mpesa');

let adminToken;
let product;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const SECRET = 'per-gateway-secret-123';
const base = '/api/integrations/payments/callbacks';

async function dispatchedOrder(phone) {
  const created = await request(app).post('/api/orders').set(auth(adminToken))
    .send({ name: 'C2B Test', phone, payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] });
  const order = created.body.data;
  await request(app).post(`/api/orders/${order.id}/dispatch`).set(auth(adminToken));
  return order;
}

const c2b = (order, transId) => ({
  TransactionType: 'Pay Bill', TransID: transId, TransTime: '20261001120000', TransAmount: (order.total / 100).toFixed(2),
  BusinessShortCode: '600988', BillRefNumber: order.product_code, MSISDN: '254708374149', FirstName: 'John', MiddleName: '', LastName: 'Doe',
});

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  product = (await request(app).get('/api/products?pageSize=1').set(auth(adminToken))).body.data[0];
  const saved = await request(app).put('/api/settings/payment-gateways/mpesa').set(auth(adminToken)).send({
    environment: 'sandbox', mpesa_shortcode: '600988', mpesa_consumer_key: 'ck', mpesa_consumer_secret: 'cs', mpesa_passkey: 'pk', webhook_secret: SECRET,
  });
  expect(saved.status).toBe(200);
});

afterAll(() => cleanupTestDb());

describe('M-Pesa C2B callbacks on the Safaricom-safe /c2b/ path', () => {
  it('confirmation on /c2b/ matches the order, applies the payment, and acks in Safaricom\'s shape', async () => {
    const order = await dispatchedOrder('0722100001');
    const res = await request(app).post(`${base}/c2b/${SECRET}/confirmation`).send(c2b(order, 'C2BTX1'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ResultCode: 0, ResultDesc: 'Success' });
    const after = (await request(app).get(`/api/orders/${order.id}`).set(auth(adminToken))).body.data;
    expect(after.status).toBe('dispatched_paid');
  });

  it('validation on /c2b/ accepts', async () => {
    const res = await request(app).post(`${base}/c2b/${SECRET}/validation`).send({ TransID: 'V1' });
    expect(res.status).toBe(200);
    expect(res.body.ResultCode).toBe(0);
  });

  it('the global PAYMENT_WEBHOOK_SECRET also works as the token', async () => {
    const order = await dispatchedOrder('0722100002');
    const res = await request(app).post(`${base}/c2b/global-test-webhook-secret/confirmation`).send(c2b(order, 'C2BTX2'));
    expect(res.status).toBe(200);
    expect((await request(app).get(`/api/orders/${order.id}`).set(auth(adminToken))).body.data.status).toBe('dispatched_paid');
  });

  it('the legacy /mpesa/ spelling keeps working (nothing already registered breaks)', async () => {
    const order = await dispatchedOrder('0722100003');
    const res = await request(app).post(`${base}/mpesa/${SECRET}/confirmation`).send(c2b(order, 'C2BTX3'));
    expect(res.status).toBe(200);
    expect((await request(app).get(`/api/orders/${order.id}`).set(auth(adminToken))).body.data.status).toBe('dispatched_paid');
  });

  it('a redelivered confirmation is not applied twice', async () => {
    const order = await dispatchedOrder('0722100004');
    const body = c2b(order, 'C2BTX4');
    await request(app).post(`${base}/c2b/${SECRET}/confirmation`).send(body);
    await request(app).post(`${base}/c2b/${SECRET}/confirmation`).send(body);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM payment_notifications WHERE external_reference = 'C2BTX4'`).get().n).toBe(1);
    expect((await request(app).get(`/api/orders/${order.id}`).set(auth(adminToken))).body.data.amount_paid).toBe(order.total);
  });

  it('a wrong token is a plain 404', async () => {
    const res = await request(app).post(`${base}/c2b/not-the-secret/confirmation`).send({ TransID: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('Register webhook URLs with Safaricom', () => {
  afterEach(() => { delete process.env.APP_BASE_URL; vi.restoreAllMocks(); });

  it('sends Safaricom URLs that do NOT contain "mpesa" or "safaricom"', async () => {
    process.env.APP_BASE_URL = 'https://pos.example.co.ke/';
    const spy = vi.spyOn(mpesaClient, 'registerC2BUrls').mockResolvedValue({ ResponseDescription: 'Success' });
    const res = await request(app).post('/api/settings/payment-gateways/mpesa/register-urls').set(auth(adminToken));
    expect(res.status).toBe(200);

    const { validationUrl, confirmationUrl } = spy.mock.calls[0][1];
    expect(confirmationUrl).toBe(`https://pos.example.co.ke${base}/c2b/${SECRET}/confirmation`);
    expect(validationUrl).toBe(`https://pos.example.co.ke${base}/c2b/${SECRET}/validation`);
    for (const u of [validationUrl, confirmationUrl]) {
      expect(u).not.toMatch(/mpesa|m-pesa|safaricom/i);
      expect(u.startsWith('https://')).toBe(true);
    }
    expect(res.body.data.confirmationUrl).toBe(confirmationUrl);
  });

  it('explains itself when APP_BASE_URL is missing', async () => {
    const res = await request(app).post('/api/settings/payment-gateways/mpesa/register-urls').set(auth(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('APP_BASE_URL');
  });

  it('refuses an APP_BASE_URL whose own address contains a word Safaricom blocks', async () => {
    process.env.APP_BASE_URL = 'https://mpesa-pos.example.com';
    const spy = vi.spyOn(mpesaClient, 'registerC2BUrls').mockResolvedValue({});
    const res = await request(app).post('/api/settings/payment-gateways/mpesa/register-urls').set(auth(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('"mpesa" or "safaricom"');
    expect(spy).not.toHaveBeenCalled();
  });

  it('the STK push callback URL is also Safaricom-safe', async () => {
    process.env.APP_BASE_URL = 'https://pos.example.co.ke';
    const spy = vi.spyOn(mpesaClient, 'initiateStkPush').mockResolvedValue({ ResponseCode: '0', CheckoutRequestID: 'ws_CO_1', MerchantRequestID: 'm1' });
    const res = await request(app).post('/api/settings/payment-gateways/mpesa/stk-push').set(auth(adminToken))
      .send({ phone: '254708374149', amount: 10, accountReference: 'UT000001' });
    expect(res.status).toBe(200);
    expect(spy.mock.calls[0][1].callbackUrl).toBe(`https://pos.example.co.ke${base}/c2b/${SECRET}/stk`);
    expect(spy.mock.calls[0][1].callbackUrl).not.toMatch(/mpesa|safaricom/i);
  });
});
