import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { adaptKcb, kcbAck, kcbTransCode } from '../src/integrations/kcb.js';
import { adaptStkCallback } from '../src/integrations/mpesa.js';
import { putSecret } from '../src/integrations/secrets.js';
import { recordStkPushRequest } from '../src/integrations/stk.js';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { createLogger } from '../src/logger.js';
import { getOrderTx } from '../src/orders/orders.js';
import { KEY, makeEnv, newOrder, type Env } from './orderHelpers.js';

const TOKEN = 'a-long-random-paybill-token-0123456789';
const SECRETS_KEY = 'secrets-key-for-tests-0123456789abcdef-xyz';

let env: Env;
beforeAll(async () => { env = await makeEnv(); });
afterAll(() => env.db.drop());

const app = (over: Record<string, unknown> = {}) => createApp({ pool: env.db.pool, logger: createLogger('silent'), orderRefKey: KEY, webhookSecret: TOKEN, secretsKey: SECRETS_KEY, ...over });
const kcb = (body: unknown, token = TOKEN, a = app()) => request(a).post(`/api/integrations/payments/callbacks/kcb/${token}/callback`).send(body as object);
const stk = (body: unknown, token = TOKEN, a = app()) => request(a).post(`/api/integrations/payments/callbacks/c2b/${token}/stk`).send(body as object);
const q = async (sql: string, args: unknown[] = []) => (await env.db.pool.query(sql, args)).rows;
const count = async (table: string, where = 'true', args: unknown[] = []) => Number((await q(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, args))[0].n);

async function fingerprint(): Promise<Record<string, string>> {
  const tables = await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`);
  const out: Record<string, string> = {};
  for (const { table_name: t } of tables) out[t] = (await q(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`))[0].h;
  return out;
}

let n = 0;
const ipn = (over: { account?: string; amount?: string; id?: string | null; currency?: string; messageID?: string } = {}) => ({
  header: { messageID: over.messageID ?? `msg-${n++}`, originatorConversationID: `conv-${n}`, channelCode: '99', timeStamp: '20261028143000' },
  requestPayload: {
    primaryData: { businessKey: `8025631#${over.account ?? 'nothing'}`, businessKeyType: 'ACCOUNT' },
    additionalData: { notificationData: {
      businessKey: `8025631#${over.account ?? 'nothing'}`, debitMSISDN: '254700111222', transactionAmt: over.amount ?? '1500.00',
      transactionID: over.id === null ? undefined : (over.id ?? `FT26${String(1_000_000 + n++)}`), currency: over.currency ?? 'KES',
      firstName: 'JANE', middleName: '', lastName: 'DOE', narration: 'paybill', transactionType: 'PAYBILL', balance: '0',
    } },
  },
});

const stkBody = (over: { checkout?: string; code?: number; amount?: number; receipt?: string } = {}) => {
  const code = over.code ?? 0;
  return { Body: { stkCallback: {
    MerchantRequestID: `m-${n++}`, CheckoutRequestID: over.checkout ?? `ws_CO_${String(2_000_000 + n++)}`, ResultCode: code,
    ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user',
    ...(code === 0 ? { CallbackMetadata: { Item: [
      { Name: 'Amount', Value: over.amount ?? 1 }, { Name: 'MpesaReceiptNumber', Value: over.receipt ?? `RK${String(7_000_000 + n++)}` },
      { Name: 'TransactionDate', Value: 20261028143000 }, { Name: 'PhoneNumber', Value: 254712345678 } ] } } : {}),
  } } };
};

describe('KCB: reading the notice', () => {
  it('maps the envelope: the account is the part after the #, codes carry a KCB prefix', () => {
    const r = adaptKcb(ipn({ account: 'UT-ABCD2345', id: 'FT26123456', amount: '1,500.00' }));
    expect(r).toMatchObject({ ok: true, notice: { transCode: 'KCBFT26123456', amountCents: 150_000, accountRef: 'UT-ABCD2345', msisdn: '254700111222', payerName: 'JANE DOE' } });
  });
  it('falls back to the message id when there is no transaction id, still giving a valid code', () => {
    const r = adaptKcb(ipn({ id: null, messageID: 'abc-123-def' }));
    expect(r.ok && r.notice.transCode).toMatch(/^KCB[A-Z0-9]{17}$/);
  });
  it('long or odd ids are shortened by hash, deterministically', () => {
    const a = kcbTransCode('a-very-long-transaction-id-0001'); const b = kcbTransCode('a-very-long-transaction-id-0001');
    expect(a).toBe(b); expect(a).toMatch(/^KCB[A-Z0-9]{17}$/);
    expect(kcbTransCode('a-very-long-transaction-id-0002')).not.toBe(a);
  });
  it('refuses another currency, a bad amount, and a notice with no id at all', () => {
    expect(adaptKcb(ipn({ currency: 'USD' }))).toMatchObject({ ok: false, reason: expect.stringContaining('USD') });
    expect(adaptKcb(ipn({ amount: 'lots' }))).toMatchObject({ ok: false });
    const noId = ipn({ id: null }); delete (noId.header as Record<string, unknown>).messageID;
    expect(adaptKcb(noId)).toMatchObject({ ok: false });
  });
  it('reads a flat body, and echoes the ids KCB sent in its acknowledgement', () => {
    expect(adaptKcb({ transactionId: 'ABC123456', amount: 99, accountNumber: 'UT-X' })).toMatchObject({ ok: true, notice: { transCode: 'KCBABC123456', amountCents: 9_900 } });
    const body = ipn({ id: 'FT26000001' });
    expect(kcbAck(body)).toEqual({ header: { messageID: body.header.messageID, originatorConversationID: body.header.originatorConversationID, statusCode: '0', statusMessage: 'Notification received successfully' }, responsePayload: { transactionInfo: { transactionID: 'FT26000001' } } });
  });
});

describe('KCB: callback', () => {
  it('a payment for a real order is applied, and KCB gets its own acknowledgement', async () => {
    const o = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: 150_000 }] });
    const body = ipn({ account: o.orderRef });
    const r = await kcb(body);
    expect(r.status).toBe(200);
    expect(r.body.header).toMatchObject({ statusCode: '0', messageID: body.header.messageID });
    expect(r.body.responsePayload.transactionInfo.transactionID).toBe(body.requestPayload.additionalData.notificationData.transactionID);
    const after = (await getOrderTx(env.db.pool, o.orderRef))!;
    expect(after.paymentStatus).toBe('paid');
    expect(after.balanceCents).toBe(0);
  });

  it('a flat body gets the older flat reply', async () => {
    const r = await kcb({ transactionId: `FLAT${n++}0001`, amount: '10.00', accountNumber: 'no such order' });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ status: 'received' });
    expect(await count('paybill_payments', `trans_code LIKE 'KCBFLAT%'`)).toBe(1);
  });

  it('replaying the same notice changes nothing, anywhere; copies at the same instant are one payment', async () => {
    const o = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: 60_000 }] });
    const body = ipn({ account: o.orderRef, amount: '600.00' });
    const first = await kcb(body);
    const after = await fingerprint();
    for (let i = 0; i < 4; i++) expect((await kcb(body)).body).toEqual(first.body);
    expect(await fingerprint()).toEqual(after);

    const o2 = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: 40_000 }] });
    const b2 = ipn({ account: o2.orderRef, amount: '400.00' });
    expect((await Promise.all(Array.from({ length: 6 }, () => kcb(b2)))).map((x) => x.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await count('payment_receipts', 'order_ref = $1', [o2.orderRef])).toBe(1);
  });

  it('a payment in another currency is never booked as shillings: kept as received, one alert, acknowledged, replays change nothing', async () => {
    const body = ipn({ currency: 'USD', amount: '50.00', account: 'UT-ZZZZ9999' });
    const before = await count('paybill_payments');
    const r = await kcb(body);
    expect(r.status).toBe(200);
    expect(r.body.header.statusCode).toBe('0');
    expect(await count('paybill_payments')).toBe(before);
    const ev = await q(`SELECT status, error, payload FROM webhook_events WHERE provider = 'kcb' AND status = 'malformed'`);
    expect(ev).toHaveLength(1);
    expect(ev[0].error).toContain('USD');
    expect(ev[0].payload).toEqual(body);
    expect(await count('alerts', `kind = 'kcb_notice_unreadable' AND acknowledged_at IS NULL`)).toBe(1);
    const after = await fingerprint();
    for (let i = 0; i < 3; i++) expect((await kcb(body)).status).toBe(200);
    expect(await fingerprint()).toEqual(after);
  });

  it('a KCB code and an M-Pesa code that look alike are two different payments', async () => {
    const same = 'QX12345678';
    await request(app()).post(`/api/integrations/payments/callbacks/c2b/${TOKEN}/confirmation`).send({ TransID: same, TransAmount: '10.00', BillRefNumber: 'x' });
    await kcb(ipn({ id: same, amount: '20.00' }));
    const rows = await q(`SELECT trans_code, amount_cents FROM paybill_payments WHERE trans_code IN ($1, $2) ORDER BY amount_cents`, [same, `KCB${same}`]);
    expect(rows.map((x) => [x.trans_code, Number(x.amount_cents)])).toEqual([[same, 1_000], [`KCB${same}`, 2_000]]);
  });

  it('its own stored token works, the other provider\'s does not, and a wrong token falls through', async () => {
    await putSecret(env.db.pool, SECRETS_KEY, { provider: 'kcb', name: 'webhook_token', value: 'kcb-stored-token-0123456789abcdef', actor: 'admin' });
    const a = app({ webhookSecret: undefined });
    expect((await kcb(ipn(), 'kcb-stored-token-0123456789abcdef', a)).status).toBe(200);
    expect((await kcb(ipn(), 'nope', a)).status).toBe(401);
    await putSecret(env.db.pool, SECRETS_KEY, { provider: 'mpesa', name: 'webhook_token', value: 'mpesa-stored-token-0123456789abcdef', actor: 'admin' });
    expect((await kcb(ipn(), 'mpesa-stored-token-0123456789abcdef', a)).status).toBe(401); // an M-Pesa token does not open the KCB door
  });

  it('a failure on our side answers 500 in KCB\'s own shape, and the retry recovers the notice', async () => {
    const body = ipn({ account: 'whatever', amount: '33.00' });
    await q(`ALTER TABLE payment_exceptions RENAME TO payment_exceptions_off`);
    let failed;
    try { failed = await kcb(body); } finally { await q(`ALTER TABLE payment_exceptions_off RENAME TO payment_exceptions`); }
    expect(failed.status).toBe(500);
    expect(failed.body.header.statusCode).toBe('1');
    expect(await count('webhook_events', `provider = 'kcb' AND status = 'failed'`)).toBe(1);
    expect((await kcb(body)).status).toBe(200);
    expect(await count('webhook_events', `provider = 'kcb' AND status = 'failed'`)).toBe(0);
    expect(await count('paybill_payments', `trans_code = $1`, [kcbTransCode(body.requestPayload.additionalData.notificationData.transactionID!)])).toBe(1);
  });
});

describe('STK push: reading the result', () => {
  it('reads a success and a cancellation', () => {
    const ok = adaptStkCallback(stkBody({ checkout: 'ws_CO_1', amount: 250, receipt: 'RK12345678' }));
    expect(ok).toMatchObject({ checkoutRequestId: 'ws_CO_1', succeeded: true, amount: 250, receipt: 'RK12345678', phone: '254712345678' });
    expect(adaptStkCallback(stkBody({ code: 1032 }))).toMatchObject({ succeeded: false, resultCode: 1032, receipt: undefined });
    expect(adaptStkCallback({})).toBeNull();
    expect(adaptStkCallback({ Body: { stkCallback: { CheckoutRequestID: 'x' } } })).toBeNull();
  });
});

describe('STK push: callback', () => {
  it('a paid push is matched to the order recorded when it was sent', async () => {
    const o = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: 120_000 }] });
    const body = stkBody({ amount: 1200 });
    await recordStkPushRequest(env.db.pool, { checkoutRequestId: body.Body.stkCallback.CheckoutRequestID, accountReference: o.orderRef, phone: '254712345678', amountCents: 120_000, actor: 'cashier1' });
    const r = await stk(body);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ResultCode: 0, ResultDesc: 'Success' });
    const after = (await getOrderTx(env.db.pool, o.orderRef))!;
    expect(after.paymentStatus).toBe('paid');
    expect((await q(`SELECT status, result_code FROM stk_push_requests WHERE checkout_request_id = $1`, [body.Body.stkCallback.CheckoutRequestID]))[0]).toMatchObject({ status: 'completed', result_code: 0 });
  });

  it('replaying it changes nothing; and the paybill confirmation for the same payment is recognised, not booked again', async () => {
    const o = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: 80_000 }] });
    const body = stkBody({ amount: 800, receipt: 'RKDUAL0001' });
    await recordStkPushRequest(env.db.pool, { checkoutRequestId: body.Body.stkCallback.CheckoutRequestID, accountReference: o.orderRef, amountCents: 80_000, actor: 'c' });
    await stk(body);
    const after = await fingerprint();
    for (let i = 0; i < 3; i++) expect((await stk(body)).status).toBe(200);
    expect(await fingerprint()).toEqual(after);

    // Safaricom also reports the same payment on the paybill confirmation URL.
    await request(app()).post(`/api/integrations/payments/callbacks/c2b/${TOKEN}/confirmation`).send({ TransID: 'RKDUAL0001', TransAmount: '800.00', BillRefNumber: o.orderRef });
    expect(await count('paybill_payments', `trans_code = 'RKDUAL0001'`)).toBe(1);
    expect((await getOrderTx(env.db.pool, o.orderRef))!.balanceCents).toBe(0);
  });

  it('a cancelled push books nothing and settles the request as failed', async () => {
    const body = stkBody({ code: 1032 });
    await recordStkPushRequest(env.db.pool, { checkoutRequestId: body.Body.stkCallback.CheckoutRequestID, accountReference: 'UT-WHATEVER', amountCents: 5_000, actor: 'c' });
    const before = await count('paybill_payments');
    expect((await stk(body)).status).toBe(200);
    expect(await count('paybill_payments')).toBe(before);
    expect((await q(`SELECT status, result_code FROM stk_push_requests WHERE checkout_request_id = $1`, [body.Body.stkCallback.CheckoutRequestID]))[0]).toMatchObject({ status: 'failed', result_code: 1032 });
    const after = await fingerprint();
    expect((await stk(body)).status).toBe(200);
    expect(await fingerprint()).toEqual(after);
  });

  it('a successful push this system never sent is not dropped: the money waits in suspense and one alert is raised', async () => {
    const body = stkBody({ amount: 345, receipt: 'RKGHOST001' });
    expect((await stk(body)).status).toBe(200);
    expect((await q(`SELECT outcome, amount_cents FROM paybill_payments WHERE trans_code = 'RKGHOST001'`))[0]).toMatchObject({ outcome: 'suspense', amount_cents: 34500 });
    expect(await count('alerts', `kind = 'mpesa_stk_unknown_request' AND acknowledged_at IS NULL`)).toBe(1);
    const after = await fingerprint();
    for (let i = 0; i < 3; i++) await stk(body);
    expect(await fingerprint()).toEqual(after);
  });

  it('an unknown push that failed is just recorded; an unreadable body is kept for review', async () => {
    const before = await count('paybill_payments');
    expect((await stk(stkBody({ code: 1037 }))).status).toBe(200);
    expect(await count('paybill_payments')).toBe(before);
    const junk = { Body: { nothing: true } };
    expect((await stk(junk)).status).toBe(200);
    expect((await q(`SELECT payload FROM webhook_events WHERE status = 'malformed' AND kind = 'stk_callback'`))[0].payload).toEqual(junk);
  });

  it('a success whose amount cannot be read is kept for review, not guessed', async () => {
    const body = stkBody({ receipt: 'RKBADAMT01' });
    (body.Body.stkCallback.CallbackMetadata!.Item[0] as { Value: unknown }).Value = 'one thousand';
    expect((await stk(body)).status).toBe(200);
    expect(await count('paybill_payments', `trans_code = 'RKBADAMT01'`)).toBe(0);
    expect(await count('webhook_events', `kind = 'stk_callback' AND status = 'malformed' AND error LIKE '%amount%'`)).toBe(1);
  });

  it('a wrong token falls through like any unknown address', async () => {
    expect((await stk(stkBody(), 'nope')).status).toBe(401);
  });
});

describe('after all of it, the money rules still hold', () => {
  it('the integrity check is clean', async () => {
    const report = await runIntegrityChecks(env.db.pool);
    expect(report.ok).toBe(true);
  });
});
