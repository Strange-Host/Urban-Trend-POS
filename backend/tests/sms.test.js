process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret';

const bcrypt = require('bcryptjs');
const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const zettatel = require('../src/config/zettatel');
const smsService = require('../src/services/sms.service');
const templates = require('../src/services/smsTemplates');
const { toMsisdn } = require('../src/utils/phone');

let adminToken;
let cashierToken;
let product;
let sendSpy;

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const outbox = (where = '1=1') => db.prepare(`SELECT * FROM sms_outbox WHERE ${where} ORDER BY id`).all();

async function putSettings(values) {
  const res = await request(app).put('/api/settings').set(auth(adminToken)).send(values);
  expect(res.status).toBe(200);
}

async function createOrder(phone, name = 'Wanjiru Kamau', quantity = 1) {
  const res = await request(app).post('/api/orders').set(auth(adminToken))
    .send({ name, phone, payment_type: 'prepaid', items: [{ product_id: product.id, quantity }] });
  expect(res.status).toBe(201);
  return res.body.data;
}

async function dispatch(orderId) {
  const res = await request(app).post(`/api/orders/${orderId}/dispatch`).set(auth(adminToken));
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  adminToken = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=1').set(auth(adminToken));
  product = res.body.data[0];

  const store = db.prepare('SELECT id FROM stores LIMIT 1').get();
  db.prepare(`INSERT INTO users (store_id, name, email, password_hash, role, is_active) VALUES (?, 'Cashier C', 'cashier-sms@urbantrends.com', ?, 'cashier', 1)`)
    .run(store.id, bcrypt.hashSync('CashierPass123!', 10));
  const login = await request(app).post('/api/auth/login').send({ email: 'cashier-sms@urbantrends.com', password: 'CashierPass123!' });
  cashierToken = login.body.token;

  sendSpy = vi.spyOn(zettatel, 'sendSms');
});

afterAll(() => cleanupTestDb());

describe('SMS templates (unit)', () => {
  const base = { business_name: 'Urban Trends', sms_delivery_promise: 'It will be delivered within the next 24 hours.', paybill_number: '', kcb_account_prefix: '', sms_catalog_url: '' };

  it('formats shillings from cents', () => {
    expect(templates.formatKes(150000)).toBe('1,500');
    expect(templates.formatKes(150050)).toBe('1,500.50');
    expect(templates.formatKes(100)).toBe('1');
    expect(templates.formatKes(123456789)).toBe('1,234,567.89');
  });

  it('summarizes multi-product orders', () => {
    expect(templates.summarizeProducts(['Shoes'])).toBe('Shoes');
    expect(templates.summarizeProducts(['Shoes', 'Socks', 'Belt'])).toBe('Shoes +2 more');
    expect(templates.summarizeProducts([])).toBe('your items');
  });

  it('order-received includes paybill and the prefixed account when configured', () => {
    const body = templates.orderReceived({
      settings: { ...base, paybill_number: '522533', kcb_account_prefix: '8025631' },
      customerName: 'Wanjiru Kamau', productNames: ['Sneakers'], productCode: 'UT000042',
    });
    expect(body).toContain('Hi Wanjiru, we have received your order for Sneakers.');
    expect(body).toContain('within the next 24 hours');
    expect(body).toContain('Pay via Paybill 522533, Account 8025631#UT000042.');
  });

  it('order-received falls back to just the reference when no paybill is set', () => {
    const body = templates.orderReceived({ settings: base, customerName: 'A B', productNames: ['X'], productCode: 'UT000001' });
    expect(body).toContain('Your payment reference: UT000001.');
    expect(body).not.toContain('Paybill');
  });

  it('payment-received distinguishes a part-payment from a full one', () => {
    const partial = templates.paymentReceived({ settings: { ...base, paybill_number: '522533' }, customerName: 'Jo', productCode: 'UT000007', amountCents: 50000, balanceCents: 150000 });
    expect(partial).toContain('payment of KES 500');
    expect(partial).toContain('Balance remaining: KES 1,500');
    expect(partial).toContain('Paybill 522533');

    const full = templates.paymentReceived({ settings: { ...base, sms_catalog_url: 'https://example.com/shop' }, customerName: 'Jo', productCode: 'UT000007', amountCents: 200000, balanceCents: 0 });
    expect(full).toContain('fully paid');
    expect(full).not.toContain('Balance remaining');
    expect(full).toContain('https://example.com/shop');
  });

  it('normalizes Kenyan numbers to MSISDN and rejects junk', () => {
    expect(toMsisdn('0712 345 678')).toBe('254712345678');
    expect(toMsisdn('+254112345678')).toBe('254112345678');
    expect(toMsisdn('254712345678')).toBe('254712345678');
    expect(toMsisdn('712345678')).toBe('254712345678');
    expect(toMsisdn('12345')).toBeNull();
    expect(toMsisdn('0512345678')).toBeNull();
    expect(toMsisdn(null)).toBeNull();
  });
});

describe('SMS — queueing on business events', () => {
  it('queues nothing while SMS is switched off (the default)', async () => {
    await createOrder('0711000001');
    expect(outbox()).toHaveLength(0);
  });

  it('queues an order_received message with product, paybill and prefixed account once enabled', async () => {
    await putSettings({ sms_enabled: '1', paybill_number: '522533', kcb_account_prefix: '8025631' });
    const order = await createOrder('0711000002');
    const rows = outbox(`template = 'order_received'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].to_phone).toBe('254711000002');
    expect(rows[0].status).toBe('queued');
    expect(rows[0].body).toContain(product.name);
    expect(rows[0].body).toContain('Paybill 522533');
    expect(rows[0].body).toContain(`8025631#${order.product_code}`);
  });

  it('skips a customer whose number is not a valid Kenyan mobile — and the order still saves', async () => {
    db.prepare('DELETE FROM sms_outbox').run();
    const order = await createOrder('55512', 'Bad Number');
    expect(order.id).toBeTruthy();
    expect(outbox()).toHaveLength(0);
  });

  it('honours the per-template switch', async () => {
    await putSettings({ sms_send_order_received: '0' });
    db.prepare('DELETE FROM sms_outbox').run();
    await createOrder('0711000003');
    expect(outbox()).toHaveLength(0);
    await putSettings({ sms_send_order_received: '1' });
  });

  it('queues a payment_received message per payment, with the remaining balance, and never duplicates a redelivered webhook', async () => {
    db.prepare('DELETE FROM sms_outbox').run();
    const order = await createOrder('0711000004');
    await dispatch(order.id);

    const half = Math.round(order.total / 2);
    const first = await request(app).post('/api/integrations/payments/callbacks/kcb/test-webhook-secret/callback')
      .send({ amount: (half / 100).toFixed(2), transactionId: 'SMS-TX-1', accountNumber: order.product_code });
    expect(first.status).toBe(201);
    // Same webhook delivered again — must not text the customer a second time.
    await request(app).post('/api/integrations/payments/callbacks/kcb/test-webhook-secret/callback')
      .send({ amount: (half / 100).toFixed(2), transactionId: 'SMS-TX-1', accountNumber: order.product_code });

    let payments = outbox(`template = 'payment_received'`);
    expect(payments).toHaveLength(1);
    expect(payments[0].body).toContain('Balance remaining');

    await request(app).post('/api/integrations/payments/callbacks/kcb/test-webhook-secret/callback')
      .send({ amount: ((order.total - half) / 100).toFixed(2), transactionId: 'SMS-TX-2', accountNumber: order.product_code });
    payments = outbox(`template = 'payment_received'`);
    expect(payments).toHaveLength(2);
    expect(payments[1].body).toContain('fully paid');
  });

  it('dedupes by key', () => {
    db.prepare('DELETE FROM sms_outbox').run();
    const storeId = db.prepare('SELECT id FROM stores LIMIT 1').get().id;
    const a = smsService.enqueue({ storeId, toPhone: '0711999999', template: 'test', body: 'x', dedupeKey: 'k1' });
    const b = smsService.enqueue({ storeId, toPhone: '0711999999', template: 'test', body: 'x', dedupeKey: 'k1' });
    expect(a.queued).toBe(true);
    expect(b).toEqual({ queued: false, reason: 'duplicate' });
    expect(outbox()).toHaveLength(1);
  });
});

describe('SMS — credentials', () => {
  it('stores credentials encrypted and never echoes them back', async () => {
    const res = await request(app).put('/api/sms/credentials').set(auth(adminToken))
      .send({ user_id: 'urban-user', password: 'S3cretPassw0rd', sender_id: 'UrbanTrends' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ configured: true, has_user_id: true, has_password: true, sender_id: 'UrbanTrends' });
    expect(JSON.stringify(res.body)).not.toContain('S3cretPassw0rd');
    expect(JSON.stringify(res.body)).not.toContain('urban-user');

    const row = db.prepare('SELECT * FROM sms_credentials').get();
    expect(row.password_enc.startsWith('enc:v1:')).toBe(true);
    expect(row.password_enc).not.toContain('S3cretPassw0rd');
    expect(row.user_id_enc.startsWith('enc:v1:')).toBe(true);

    const get = await request(app).get('/api/sms/credentials').set(auth(adminToken));
    expect(JSON.stringify(get.body)).not.toContain('S3cretPassw0rd');
  });

  it('keeps the stored password when only the sender ID is re-saved', async () => {
    const before = db.prepare('SELECT password_enc FROM sms_credentials').get().password_enc;
    const res = await request(app).put('/api/sms/credentials').set(auth(adminToken)).send({ sender_id: 'UT' });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT password_enc FROM sms_credentials').get().password_enc).toBe(before);
    await request(app).put('/api/sms/credentials').set(auth(adminToken)).send({ sender_id: 'UrbanTrends' });
  });

  it('does not let a cashier read or change credentials, or send a test', async () => {
    expect((await request(app).get('/api/sms/credentials').set(auth(cashierToken))).status).toBe(403);
    expect((await request(app).put('/api/sms/credentials').set(auth(cashierToken)).send({ sender_id: 'X' })).status).toBe(403);
    expect((await request(app).post('/api/sms/test').set(auth(cashierToken)).send({ to: '0712345678' })).status).toBe(403);
    expect((await request(app).get('/api/sms/outbox').set(auth(cashierToken))).status).toBe(403);
    expect((await request(app).get('/api/sms/outbox')).status).toBe(401);
  });

  it('refuses a first save without both user id and password', async () => {
    db.prepare('DELETE FROM sms_credentials').run();
    const res = await request(app).put('/api/sms/credentials').set(auth(adminToken)).send({ user_id: 'only-user' });
    expect(res.status).toBe(400);
    await request(app).put('/api/sms/credentials').set(auth(adminToken)).send({ user_id: 'urban-user', password: 'S3cretPassw0rd', sender_id: 'UrbanTrends' });
  });
});

describe('SMS — outbox worker', () => {
  const storeId = () => db.prepare('SELECT id FROM stores LIMIT 1').get().id;
  const queueOne = (key) => smsService.enqueue({ storeId: storeId(), toPhone: '0722000001', template: 'test', body: 'hello', dedupeKey: key }).id;

  beforeEach(() => {
    db.prepare('DELETE FROM sms_outbox').run();
    sendSpy.mockReset();
  });

  it('sends a due message with the stored credentials and marks it sent', async () => {
    sendSpy.mockResolvedValue({ ok: true, response: '{"status":"success"}' });
    const id = queueOne('w1');
    const summary = await smsService.processOutbox();
    expect(summary.sent).toBe(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const call = sendSpy.mock.calls[0][0];
    expect(call.creds).toMatchObject({ userId: 'urban-user', password: 'S3cretPassw0rd', senderId: 'UrbanTrends', msgType: 'unicode' });
    expect(call.to).toBe('254722000001');
    const row = db.prepare('SELECT * FROM sms_outbox WHERE id = ?').get(id);
    expect(row.status).toBe('sent');
    expect(row.sent_at).toBeTruthy();
    expect(row.provider_response).toContain('success');
  });

  it('retries with backoff on failure, then fails permanently after the max attempts', async () => {
    sendSpy.mockResolvedValue({ ok: false, error: 'HTTP 503', response: 'unavailable' });
    const id = queueOne('w2');

    let summary = await smsService.processOutbox();
    expect(summary.retried).toBe(1);
    let row = db.prepare('SELECT * FROM sms_outbox WHERE id = ?').get(id);
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe('HTTP 503');

    // Not due yet — an immediate second pass must not hit the provider again.
    summary = await smsService.processOutbox();
    expect(sendSpy).toHaveBeenCalledTimes(1);

    for (let i = 2; i <= smsService.MAX_ATTEMPTS; i++) {
      db.prepare(`UPDATE sms_outbox SET next_attempt_at = datetime('now', '-1 minute') WHERE id = ?`).run(id);
      await smsService.processOutbox();
    }
    row = db.prepare('SELECT * FROM sms_outbox WHERE id = ?').get(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(smsService.MAX_ATTEMPTS);
    expect(sendSpy).toHaveBeenCalledTimes(smsService.MAX_ATTEMPTS);
  });

  it('can retry a failed message from the API', async () => {
    sendSpy.mockResolvedValue({ ok: false, error: 'bad sender', response: null });
    const id = queueOne('w3');
    db.prepare(`UPDATE sms_outbox SET status = 'failed', attempts = 5 WHERE id = ?`).run(id);

    const res = await request(app).post(`/api/sms/outbox/${id}/retry`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('queued');
    expect(res.body.data.attempts).toBe(0);

    const again = await request(app).post(`/api/sms/outbox/${id}/retry`).set(auth(adminToken));
    expect(again.status).toBe(409); // already queued — only failed/expired can be retried
  });

  it('expires a message that sat unsent for over 24h instead of delivering it late', async () => {
    const id = queueOne('w4');
    db.prepare(`UPDATE sms_outbox SET created_at = datetime('now', '-25 hours') WHERE id = ?`).run(id);
    const summary = await smsService.processOutbox();
    expect(summary.expired).toBe(1);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status FROM sms_outbox WHERE id = ?').get(id).status).toBe('expired');
  });

  it('recovers a message stuck in "sending" after a crash', async () => {
    sendSpy.mockResolvedValue({ ok: true, response: 'ok' });
    const id = queueOne('w5');
    db.prepare(`UPDATE sms_outbox SET status = 'sending', updated_at = datetime('now', '-30 minutes') WHERE id = ?`).run(id);
    const summary = await smsService.processOutbox();
    expect(summary.sent).toBe(1);
  });

  it('leaves messages queued (not failed) while no credentials exist', async () => {
    const saved = db.prepare('SELECT * FROM sms_credentials').get();
    db.prepare('DELETE FROM sms_credentials').run();
    const id = queueOne('w6');
    const summary = await smsService.processOutbox();
    expect(summary.waitingForCredentials).toBe(1);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status, attempts FROM sms_outbox WHERE id = ?').get(id)).toEqual({ status: 'queued', attempts: 0 });
    db.prepare(`INSERT INTO sms_credentials (store_id, user_id_enc, password_enc, sender_id) VALUES (?, ?, ?, ?)`)
      .run(saved.store_id, saved.user_id_enc, saved.password_enc, saved.sender_id);
  });

  it('sends a test SMS immediately and reports the provider reply with a masked number', async () => {
    sendSpy.mockResolvedValue({ ok: true, response: '{"status":"success"}' });
    const res = await request(app).post('/api/sms/test').set(auth(adminToken)).send({ to: '0733123456' });
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    expect(res.body.data.to).toBe('25473****456');
    expect(res.body.data.providerResponse).toContain('success');
    expect(db.prepare(`SELECT status FROM sms_outbox WHERE template = 'test'`).get().status).toBe('sent');

    const bad = await request(app).post('/api/sms/test').set(auth(adminToken)).send({ to: '12345' });
    expect(bad.status).toBe(400);
  });

  it('lists the outbox for managers/admins, filtered by status', async () => {
    sendSpy.mockResolvedValue({ ok: true, response: 'ok' });
    queueOne('w7');
    await smsService.processOutbox();
    queueOne('w8');
    const res = await request(app).get('/api/sms/outbox?status=sent').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.every((r) => r.status === 'sent')).toBe(true);
    expect(res.body.total).toBe(1);

    const status = await request(app).get('/api/sms/status').set(auth(adminToken));
    expect(status.body.data.enabled).toBe(true);
    expect(status.body.data.credentials.configured).toBe(true);
  });
});

describe('Zettatel response interpretation (unit)', () => {
  it('treats HTTP-ok bodies without a failure marker as success, and explicit failures as failures', () => {
    expect(zettatel.interpretResponse({ status: 'success' })).toEqual({ ok: true });
    expect(zettatel.interpretResponse('plain text accepted')).toEqual({ ok: true });
    expect(zettatel.interpretResponse({ status: 'error', reason: 'Invalid sender id' })).toEqual({ ok: false, error: 'Invalid sender id' });
    expect(zettatel.interpretResponse({ statusCode: '401', message: 'bad login' }).ok).toBe(false);
  });
});
