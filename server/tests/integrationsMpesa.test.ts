import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { adaptMpesaConfirmation, parseTransTime, shillingsToCents } from '../src/integrations/mpesa.js';
import { decryptSecret, encryptSecret, getSecret, putSecret, safeEqual } from '../src/integrations/secrets.js';
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
const confirm = (body: unknown, token = TOKEN, a = app()) => request(a).post(`/api/integrations/payments/callbacks/c2b/${token}/confirmation`).send(body as object);

let n = 0;
const notice = (over: Record<string, unknown> = {}) => ({
  TransactionType: 'Pay Bill', TransID: `SK${String(100_000_00 + n++)}`, TransTime: '20261028143000', TransAmount: '2500.00',
  BusinessShortCode: '600000', BillRefNumber: 'garbage', MSISDN: '254712345678', FirstName: 'WANJIKU', MiddleName: '', LastName: 'W', ...over,
});

/** Every row of every table, as one fingerprint per table. If a replay changes anything anywhere, this changes. */
async function fingerprint(): Promise<Record<string, string>> {
  const { rows } = await env.db.pool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`);
  const out: Record<string, string> = {};
  for (const { table_name: t } of rows) {
    const r = await env.db.pool.query<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM "${t}" x`);
    out[t] = r.rows[0]!.h;
  }
  return out;
}

describe('amounts and times from Safaricom', () => {
  it.each([
    ['1500.00', 150_000], ['1,500', 150_000], [' 1500 ', 150_000], [1500.5, 150_050], ['0.07', 7], ['19.9', 1_990], [20, 2_000],
  ])('%j is %i cents', (input, cents) => { expect(shillingsToCents(input)).toBe(cents); });

  it.each([['abc'], [''], ['0'], ['0.00'], ['-5'], ['1.234'], ['1e3'], [NaN], [null], [undefined], [{}], ['1500.00 KES']])('%j is refused, never guessed', (input) => {
    expect(shillingsToCents(input)).toBeNull();
  });

  it('reads TransTime as Nairobi time', () => {
    expect(parseTransTime('20261028143000')?.toISOString()).toBe('2026-10-28T11:30:00.000Z');
    expect(parseTransTime('20261328143000')).toBeUndefined();
    expect(parseTransTime(undefined)).toBeUndefined();
  });

  it('maps a confirmation to a paybill notice, and says why when it cannot', () => {
    const ok = adaptMpesaConfirmation(notice({ TransID: 'SKABC12345', BillRefNumber: 'UT-ABCD2345' }));
    expect(ok).toMatchObject({ ok: true, notice: { transCode: 'SKABC12345', amountCents: 250_000, accountRef: 'UT-ABCD2345', payerName: 'WANJIKU W', msisdn: '254712345678' } });
    expect(adaptMpesaConfirmation({ TransAmount: '10' })).toMatchObject({ ok: false, reason: expect.stringContaining('TransID') });
    expect(adaptMpesaConfirmation({ TransID: 'SKABC12345', TransAmount: 'ten' })).toMatchObject({ ok: false, reason: expect.stringContaining('TransAmount') });
    expect(adaptMpesaConfirmation(null)).toMatchObject({ ok: false });
  });
});

describe('secrets at rest', () => {
  it('round-trips, and the stored value is not readable', async () => {
    await putSecret(env.db.pool, SECRETS_KEY, { provider: 'mpesa', name: 'consumer_secret', value: 'super-secret-value', actor: 'admin' });
    const raw = (await env.db.pool.query<{ ciphertext: string }>(`SELECT ciphertext FROM integration_secrets WHERE provider='mpesa' AND name='consumer_secret'`)).rows[0]!.ciphertext;
    expect(raw).not.toContain('super-secret-value');
    expect(await getSecret(env.db.pool, SECRETS_KEY, 'mpesa', 'consumer_secret')).toBe('super-secret-value');
    expect(await getSecret(env.db.pool, SECRETS_KEY, 'mpesa', 'nothing-here')).toBeNull();
    expect(await getSecret(env.db.pool, undefined, 'mpesa', 'consumer_secret')).toBeNull();
  });

  it('refuses a tampered blob, a different key, and a blob moved to another slot', () => {
    const blob = encryptSecret('value', SECRETS_KEY, 'mpesa/a');
    expect(decryptSecret(blob, SECRETS_KEY, 'mpesa/a')).toBe('value');
    expect(() => decryptSecret(blob, SECRETS_KEY.replace('s', 'S'), 'mpesa/a')).toThrow();
    expect(() => decryptSecret(blob, SECRETS_KEY, 'mpesa/b')).toThrow();
    const parts = blob.split('.'); parts[3] = Buffer.from('tampered!!!').toString('base64url');
    expect(() => decryptSecret(parts.join('.'), SECRETS_KEY, 'mpesa/a')).toThrow();
    expect(encryptSecret('value', SECRETS_KEY, 'mpesa/a')).not.toBe(blob); // a fresh IV every time
  });

  it('says it cannot store a secret when there is no key', async () => {
    await expect(putSecret(env.db.pool, undefined, { provider: 'x', name: 'y', value: 'z', actor: 'a' })).rejects.toMatchObject({ code: 'SECRETS_KEY_MISSING' });
  });

  it('compares without caring about length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'abc')).toBe(false);
  });
});

describe('who may call the callback URLs', () => {
  it('a wrong token is answered exactly like any other address that needs a login, and nothing is recorded', async () => {
    const before = await fingerprint();
    const wrong = await confirm(notice(), 'not-the-token');
    const wrongValidation = await request(app()).post('/api/integrations/payments/callbacks/c2b/not-the-token/validation').send({});
    const unknown = await request(app()).post('/api/integrations/nothing/here').send({});
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrongValidation.status).toBe(unknown.status);
    expect(wrongValidation.body).toEqual(unknown.body);
    expect(await fingerprint()).toEqual(before);
  });

  it('with no secret configured anywhere, every callback is refused the same way', async () => {
    const r = await confirm(notice(), TOKEN, app({ webhookSecret: undefined, secretsKey: undefined }));
    expect(r.status).toBe(401);
  });

  it('a token stored (encrypted) in the database works beside the one in the environment', async () => {
    await putSecret(env.db.pool, SECRETS_KEY, { provider: 'mpesa', name: 'webhook_token', value: 'stored-token-0123456789abcdef', actor: 'admin' });
    const a = app({ webhookSecret: undefined });
    expect((await confirm(notice(), 'stored-token-0123456789abcdef', a)).status).toBe(200);
    expect((await confirm(notice(), 'something-else', a)).status).toBe(401);
    expect((await confirm(notice(), TOKEN, app())).status).toBe(200); // the environment token still works when both exist
  });

  it('the older /mpesa/ spelling still reaches the same handler', async () => {
    const r = await request(app()).post(`/api/integrations/payments/callbacks/mpesa/${TOKEN}/confirmation`).send(notice());
    expect(r.status).toBe(200);
  });

  it('needs no login, and the rest of the API still does', async () => {
    expect((await confirm(notice())).status).toBe(200);
    expect((await request(app()).get('/api/orders')).status).toBe(401);
  });
});

describe('validation', () => {
  it('always lets the payment through', async () => {
    const r = await request(app()).post(`/api/integrations/payments/callbacks/c2b/${TOKEN}/validation`).send(notice({ BillRefNumber: 'who knows' }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
  });
});

describe('confirmation: money reaches the engine', () => {
  it('a payment for a real order is applied, receipted and acknowledged', async () => {
    const o = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: 250_000 }] });
    const r = await confirm(notice({ BillRefNumber: o.orderRef.toLowerCase(), TransAmount: '2500.00' }));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ResultCode: 0, ResultDesc: 'Success' });
    const after = (await getOrderTx(env.db.pool, o.orderRef))!;
    expect(after.paymentStatus).toBe('paid');
    expect(after.balanceCents).toBe(0);
  });

  it('a payment with no usable reference waits in suspense for a person', async () => {
    const t = notice({ BillRefNumber: 'my phone number', TransAmount: 777 });
    expect((await confirm(t)).status).toBe(200);
    const { rows } = await env.db.pool.query(`SELECT outcome, amount_cents FROM paybill_payments WHERE trans_code = $1`, [t.TransID]);
    expect(rows[0]).toMatchObject({ outcome: 'suspense', amount_cents: 77_700 });
  });

  it('the ledger and the integrity check stay clean', async () => {
    const report = await runIntegrityChecks(env.db.pool);
    expect(report.ok).toBe(true);
  });
});

describe('PHASE F DONE WHEN: replaying a webhook leaves PostgreSQL unchanged', () => {
  it('the same confirmation sent again and again changes nothing, anywhere', async () => {
    const o = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: 180_000 }] });
    const t = notice({ BillRefNumber: o.orderRef, TransAmount: '1800.00' });
    const first = await confirm(t);
    expect(first.status).toBe(200);
    const after = await fingerprint();
    for (let i = 0; i < 4; i++) {
      const again = await confirm(t);
      expect(again.status).toBe(200);
      expect(again.body).toEqual(first.body);
    }
    expect(await fingerprint()).toEqual(after);
    expect((await env.db.pool.query(`SELECT count(*)::int AS n FROM paybill_payments WHERE trans_code = $1`, [t.TransID])).rows[0].n).toBe(1);
    expect((await env.db.pool.query(`SELECT count(*)::int AS n FROM webhook_events WHERE event_key = $1`, [t.TransID])).rows[0].n).toBe(1);
  });

  it('copies arriving at the same instant are one payment, one receipt', async () => {
    const o = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: 90_000 }] });
    const t = notice({ BillRefNumber: o.orderRef, TransAmount: '900.00' });
    const results = await Promise.all(Array.from({ length: 6 }, () => confirm(t)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect((await env.db.pool.query(`SELECT count(*)::int AS n FROM paybill_payments WHERE trans_code = $1`, [t.TransID])).rows[0].n).toBe(1);
    expect((await env.db.pool.query(`SELECT count(*)::int AS n FROM payment_receipts WHERE order_ref = $1`, [o.orderRef])).rows[0].n).toBe(1);
    expect((await getOrderTx(env.db.pool, o.orderRef))!.balanceCents).toBe(0);
  });

  it('an unreadable notice is kept as received, raises one alert, is acknowledged, and replays change nothing', async () => {
    const bad = { TransID: 'SKBAD00001', TransAmount: 'about a thousand', BillRefNumber: 'UT-X', Extra: { kept: true } };
    const r = await confirm(bad);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ResultCode: 0, ResultDesc: 'Success' });

    const ev = (await env.db.pool.query(`SELECT status, payload, error FROM webhook_events WHERE status = 'malformed'`)).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toEqual(bad);
    expect(ev[0].error).toContain('TransAmount');
    expect((await env.db.pool.query(`SELECT count(*)::int AS n FROM alerts WHERE kind = 'mpesa_notice_unreadable' AND acknowledged_at IS NULL`)).rows[0].n).toBe(1);
    expect((await env.db.pool.query(`SELECT count(*)::int AS n FROM paybill_payments WHERE trans_code = 'SKBAD00001'`)).rows[0].n).toBe(0);

    const after = await fingerprint();
    for (let i = 0; i < 3; i++) expect((await confirm(bad)).status).toBe(200);
    expect(await fingerprint()).toEqual(after);
  });

  it('a notice with a malformed transaction code is refused by the engine and kept for review, not lost', async () => {
    const bad = notice({ TransID: 'x' });
    expect((await confirm(bad)).status).toBe(200);
    const { rows } = await env.db.pool.query(`SELECT status, error FROM webhook_events WHERE payload->>'TransID' = 'x'`);
    expect(rows[0]).toMatchObject({ status: 'malformed' });
    expect(rows[0].error).toContain('PAYMENT_BAD_CODE');
  });
});

describe('a failure on our side asks Safaricom to try again', () => {
  it('answers 500 while the database cannot finish, and the retry that succeeds recovers the notice', async () => {
    const t = notice({ BillRefNumber: 'whatever', TransAmount: '50.00' });
    // Take away something the engine needs for exactly as long as this test needs it.
    await env.db.pool.query(`ALTER TABLE payment_exceptions RENAME TO payment_exceptions_off`);
    let failed;
    try { failed = await confirm(t); } finally { await env.db.pool.query(`ALTER TABLE payment_exceptions_off RENAME TO payment_exceptions`); }
    expect(failed.status).toBe(500);
    expect(failed.body.ResultCode).toBe(1);
    expect((await env.db.pool.query(`SELECT status FROM webhook_events WHERE event_key = $1`, [t.TransID])).rows[0].status).toBe('failed');
    expect((await env.db.pool.query(`SELECT count(*)::int AS n FROM paybill_payments WHERE trans_code = $1`, [t.TransID])).rows[0].n).toBe(0); // nothing half-posted

    expect((await confirm(t)).status).toBe(200);
    expect((await env.db.pool.query(`SELECT status FROM webhook_events WHERE event_key = $1`, [t.TransID])).rows[0].status).toBe('processed');
    expect((await env.db.pool.query(`SELECT count(*)::int AS n FROM paybill_payments WHERE trans_code = $1`, [t.TransID])).rows[0].n).toBe(1);
  });
});
