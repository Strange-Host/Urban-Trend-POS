process.env.PAYMENT_WEBHOOK_SECRET = 'test-webhook-secret';

const { app, request, loginAsAdmin, cleanupTestDb } = require('./setup');
const adapters = require('../src/services/paymentCallbackAdapters');
const db = require('../src/config/db');

let token;
let product;

beforeAll(async () => {
  token = await loginAsAdmin();
  const res = await request(app).get('/api/products?pageSize=1').set('Authorization', `Bearer ${token}`);
  product = res.body.data[0];
});

afterAll(() => cleanupTestDb());

async function createDispatchedOrder(phone) {
  const createRes = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ name: 'KCB IPN Test', phone, payment_type: 'prepaid', items: [{ product_id: product.id, quantity: 1 }] });
  const order = createRes.body.data;
  await request(app).post(`/api/orders/${order.id}/dispatch`).set('Authorization', `Bearer ${token}`);
  return order;
}

// The shape KCB Buni actually delivers (copied from the older system's DTO).
function ipn({ businessKey, amount, transactionID, currency = 'KES', narration = 'Paybill payment' }) {
  return {
    header: { messageID: `msg-${transactionID}`, originatorConversationID: `conv-${transactionID}`, channelCode: '99', timeStamp: '20261001120000' },
    requestPayload: {
      primaryData: { businessKey, businessKeyType: 'ACCOUNT_NUMBER' },
      additionalData: {
        notificationData: {
          businessKey, businessKeyType: 'ACCOUNT_NUMBER', debitMSISDN: '254712345678',
          transactionAmt: amount, transactionDate: '20261001120000', transactionID,
          firstName: 'Jane', middleName: 'W', lastName: 'Doe', currency, narration, transactionType: 'PAYBILL', balance: '0.00',
        },
      },
    },
  };
}

const URL = '/api/integrations/payments/callbacks/kcb/test-webhook-secret/callback';

describe('KCB Buni IPN adapter (unit)', () => {
  it('maps the nested envelope to the reconciliation fields', () => {
    const body = ipn({ businessKey: '8025631#UT000123', amount: '1500.00', transactionID: 'TX1' });
    const out = adapters.adaptKcbCallback(body);
    expect(out.amount).toBe(150000);
    expect(out.externalReference).toBe('TX1');
    expect(out.narrative).toContain('8025631#UT000123');
    expect(out.payerName).toBe('Jane W Doe (254712345678)');
    expect(out.method).toBe('mobile_money');
  });

  it('parses amounts with thousands separators instead of reading "1,500.00" as 1', () => {
    expect(adapters.toCents('1,500.00')).toBe(150000);
    expect(adapters.toCents('abc')).toBe(0);
    expect(adapters.toCents(undefined)).toBe(0);
  });

  it('falls back to the message id when transactionID is missing', () => {
    const body = ipn({ businessKey: 'UT000001', amount: '10', transactionID: undefined });
    body.requestPayload.additionalData.notificationData.transactionID = undefined;
    body.header.messageID = 'M-77';
    expect(adapters.adaptKcbCallback(body).externalReference).toBe('kcb-msg:M-77');
  });

  it('forces a non-KES notification into the unmatched queue (no narrative to match on)', () => {
    const body = ipn({ businessKey: '8025631#UT000123', amount: '10', transactionID: 'TX2', currency: 'USD' });
    expect(adapters.adaptKcbCallback(body).narrative).toBeNull();
  });

  it('still understands a flat, non-envelope body', () => {
    const out = adapters.adaptKcbCallback({ amount: '200', transactionId: 'F1', accountNumber: 'UT000009' });
    expect(out.amount).toBe(20000);
    expect(out.narrative).toBe('UT000009');
  });
});

describe('KCB Buni IPN endpoint', () => {
  it('matches a prefixed business key to the order, applies payment, and acks in KCB\'s shape', async () => {
    const order = await createDispatchedOrder('0766100001');
    const amount = (order.total / 100).toFixed(2);
    const body = ipn({ businessKey: `8025631#${order.product_code}`, amount, transactionID: 'KCBTX-A' });

    const res = await request(app).post(URL).send(body);
    expect(res.status).toBe(200);
    expect(res.body.header).toEqual({
      messageID: 'msg-KCBTX-A', originatorConversationID: 'conv-KCBTX-A',
      statusCode: '0', statusMessage: 'Notification received successfully',
    });
    expect(res.body.responsePayload.transactionInfo.transactionID).toBe('KCBTX-A');

    const after = await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${token}`);
    expect(after.body.data.status).toBe('dispatched_paid');
    expect(after.body.data.amount_paid).toBe(order.total);
  });

  it('is idempotent — a redelivered IPN does not double-apply the payment', async () => {
    const order = await createDispatchedOrder('0766100002');
    const body = ipn({ businessKey: `8025631#${order.product_code}`, amount: ((order.total / 100) / 2).toFixed(2), transactionID: 'KCBTX-B' });

    const first = await request(app).post(URL).send(body);
    const second = await request(app).post(URL).send(body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const after = await request(app).get(`/api/orders/${order.id}`).set('Authorization', `Bearer ${token}`);
    expect(after.body.data.status).toBe('dispatched_partial');
    expect(after.body.data.amount_paid).toBe(Math.round(order.total / 2));
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM payment_notifications WHERE source = 'kcb' AND external_reference = 'KCBTX-B'`).get();
    expect(rows.n).toBe(1);
  });

  it('records an unknown account as unmatched but still acks with statusCode 0', async () => {
    const body = ipn({ businessKey: '8025631#NOSUCHCODE', amount: '300.00', transactionID: 'KCBTX-C' });
    const res = await request(app).post(URL).send(body);
    expect(res.status).toBe(200);
    expect(res.body.header.statusCode).toBe('0');
    const row = db.prepare(`SELECT status FROM payment_notifications WHERE external_reference = 'KCBTX-C'`).get();
    expect(row.status).toBe('unmatched');
  });

  it('rejects a callback with the wrong URL secret', async () => {
    const res = await request(app).post('/api/integrations/payments/callbacks/kcb/wrong/callback')
      .send(ipn({ businessKey: 'UT000001', amount: '1', transactionID: 'KCBTX-D' }));
    expect(res.status).toBe(404);
  });

  it('keeps the legacy flat response for a non-envelope body', async () => {
    const res = await request(app).post(URL).send({ amount: '50', transactionId: 'FLAT-1', accountNumber: 'UT999999' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('received');
  });
});
