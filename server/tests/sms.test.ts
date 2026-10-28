import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { setSettings, clearSettingsCache } from '../src/auth/settings.js';
import { createProduct } from '../src/catalog/products.js';
import { importOnlineOrder } from '../src/integrations/onlineOrders.js';
import { createSource } from '../src/integrations/sources.js';
import { convertLead, createLead } from '../src/leads/leads.js';
import { createLogger } from '../src/logger.js';
import { ingestPaybillPayment, recordShopCash } from '../src/orders/payments.js';
import { enqueue, getRawCredentials, MAX_ATTEMPTS, processOutbox, queueOrderReceived, removeCredentials, retryMessage, saveCredentials, scheduleSmsWorker, sendNow, sendTest, type SmsCtx } from '../src/sms/sms.js';
import { maskPhone, toMsisdn } from '../src/sms/phone.js';
import { formatKes, orderReceived, paymentReceived } from '../src/sms/templates.js';
import { interpretResponse, sendSms } from '../src/sms/zettatel.js';
import { receiveStock } from '../src/stock/stock.js';
import { runIntegrityChecks } from '../src/integrity/checks.js';
import { loggedIn } from './authHelpers.js';
import { KEY, makeEnv, newOrder, type Env } from './orderHelpers.js';
import { fakeFetch, fingerprint, json, shopifyOrder, type FakeFetch } from './storeHelpers.js';

const SECRETS_KEY = 'secrets-key-for-tests-0123456789abcdef-xyz';
const A = { actor: 'mona', role: 'manager' };
let env: Env;
beforeAll(async () => { env = await makeEnv(); });
afterAll(() => env.db.drop());

const q = async (sql: string, a: unknown[] = []) => (await env.db.pool.query(sql, a)).rows;
const count = async (where = 'true', a: unknown[] = []) => Number((await q(`SELECT count(*) AS n FROM sms_outbox WHERE ${where}`, a))[0].n);
const set = async (entries: Record<string, string>) => { await setSettings(env.db.pool, entries, 'test'); clearSettingsCache(); };
const OK = () => json({ status: 'success' });
const gateway = (reply: (c: { body: Record<string, unknown> }) => Response = OK): FakeFetch =>
  fakeFetch((c) => reply({ body: JSON.parse(c.body ?? '{}') as Record<string, unknown> }));
const ctx = (f: FakeFetch, over: Partial<SmsCtx> = {}): SmsCtx => ({ pool: env.db.pool, logger: createLogger('silent'), secretsKey: SECRETS_KEY, fetch: f, ...over });
const lastBody = async () => (await q(`SELECT body FROM sms_outbox ORDER BY id DESC LIMIT 1`))[0]?.body as string;
const CREDS = { userId: 'zet-user', password: 'zet-pass-123', senderId: 'URBAN' };

describe('numbers', () => {
  it.each([['0712 345 678', '254712345678'], ['+254712345678', '254712345678'], ['254112345678', '254112345678'], ['712345678', '254712345678'], ['0112345678', '254112345678']])('%s -> %s', (i, o) => { expect(toMsisdn(i)).toBe(o); });
  it.each([['0201234567'], ['0612345678'], ['12345'], [''], [null], [undefined], ['abc']])('%j is not a Kenyan mobile', (i) => { expect(toMsisdn(i)).toBeNull(); });
  it('masks a number for logs and screens', () => { expect(maskPhone('254712345678')).toBe('25471****678'); expect(maskPhone('123')).toBe('****'); });
});

describe('the words', () => {
  it.each([[0, '0'], [150_000, '1,500'], [150_050, '1,500.50'], [5, '0.05'], [123_456_789, '1,234,567.89'], [-250_000, '-2,500']])('%i cents is KES %s', (c, t) => { expect(formatKes(c)).toBe(t); });

  const base = { business_name: 'Urban Trends', paybill_number: '522533', sms_delivery_promise: 'Delivery within 24 hours.', sms_catalog_url: '', kcb_account_prefix: '' };
  it('order received: first name, what was bought, how to pay', () => {
    const t = orderReceived({ settings: base, customerName: 'Wanjiku Mwangi', itemNames: ['Red sneakers', 'Socks', 'Cap'], orderRef: 'UT-ABCD2345' });
    expect(t).toBe('Urban Trends\nHi Wanjiku, we have received your order for Red sneakers +2 more. Delivery within 24 hours.\nPay via Paybill 522533, Account UT-ABCD2345.\nThank you for choosing us.');
  });
  it('order received: without a paybill the customer still gets their reference; with a bank prefix it is attached; no promise, no promise', () => {
    expect(orderReceived({ settings: { ...base, paybill_number: '', sms_delivery_promise: '' }, customerName: '', itemNames: [], orderRef: 'UT-X' })).toBe('Urban Trends\nHi there, we have received your order for your items.\nYour payment reference: UT-X.\nThank you for choosing us.');
    expect(orderReceived({ settings: { ...base, kcb_account_prefix: '8025631##' }, customerName: 'Ann', itemNames: ['A'], orderRef: 'UT-X' })).toContain('Account 8025631#UT-X.');
  });
  it('payment received: a balance asks for the rest, a full payment says so, a catalogue link is added when set', () => {
    const part = paymentReceived({ settings: base, customerName: 'Ann Lee', orderRef: 'UT-X', amountCents: 100_000, balanceCents: 50_050 });
    expect(part).toBe('Urban Trends\nHi Ann, we have received your payment of KES 1,000. Balance remaining: KES 500.50.\nPay via Paybill 522533, Account UT-X.\nThank you for shopping with us.');
    const full = paymentReceived({ settings: { ...base, sms_catalog_url: 'https://shop.example.com' }, customerName: 'Ann', orderRef: 'UT-X', amountCents: 150_050, balanceCents: 0 });
    expect(full).toContain('KES 1,500.50. Your order is fully paid.');
    expect(full).not.toContain('Paybill');
    expect(full.endsWith('Browse our catalog: https://shop.example.com')).toBe(true);
  });
});

describe('the gateway', () => {
  it.each([
    [{ status: 'success' }, true], ['{"status":"ok"}', true], ['plain text accepted', true], [null, true],
    [{ status: 'error', reason: 'No credit' }, false], [{ Status: 'REJECTED' }, false], [{ statusCode: 403, message: 'bad sender' }, false], ['{"status":"failed"}', false],
  ])('%j -> %s', (data, ok) => { expect(interpretResponse(data).ok).toBe(ok); });

  const creds = { userId: 'u', password: 'p@ss.word', senderId: 'URBAN', msgType: 'unicode' as const };
  it('sends the request the gateway expects', async () => {
    const f = gateway();
    expect(await sendSms(f, creds, '254712345678', 'Hello\nthere', 'https://sms.example.com/send')).toMatchObject({ ok: true });
    expect(f.calls[0]!.url.toString()).toBe('https://sms.example.com/send');
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ userid: 'u', password: 'p@ss.word', senderid: 'URBAN', msgType: 'unicode', duplicatecheck: 'true', sendMethod: 'quick', sms: [{ mobile: ['254712345678'], msg: 'Hello\nthere' }] });
  });
  it('reports a refusal, an HTTP error and a dead network without ever echoing the password', async () => {
    expect(await sendSms(gateway(() => json({ status: 'error', reason: 'No credit' })), creds, '254712345678', 'x')).toMatchObject({ ok: false, error: 'No credit', response: expect.stringContaining('No credit') });
    expect(await sendSms(gateway(() => json({}, { status: 503 })), creds, '254712345678', 'x')).toMatchObject({ ok: false, error: 'HTTP 503' });
    expect(await sendSms(gateway(() => json({}, { status: 302, headers: { location: 'https://evil.example.com' } })), creds, '254712345678', 'x')).toMatchObject({ ok: false, error: 'HTTP 302' });
    const dead = await sendSms(fakeFetch(() => { throw new Error('connect failed for user u password p@ss.word'); }), creds, '254712345678', 'x');
    expect(dead.ok).toBe(false);
    expect(dead.error).not.toContain('p@ss.word');
    expect(dead.error).toContain('connect failed');
    expect(JSON.stringify(dead)).not.toContain('p@ss.word');
  });
});

describe('credentials', () => {
  it('are saved encrypted, shown only as flags, and can be updated in part or removed', async () => {
    const c = ctx(gateway());
    await expect(saveCredentials(c, { userId: 'only-a-user', actor: 'admin' })).rejects.toMatchObject({ code: 'SMS_CREDENTIALS_INCOMPLETE' });
    const saved = await saveCredentials(c, { ...CREDS, actor: 'admin' });
    expect(saved).toEqual({ configured: true, source: 'database', hasUserId: true, hasPassword: true, senderId: 'URBAN' });
    expect(JSON.stringify(await q(`SELECT * FROM integration_secrets WHERE provider = 'zettatel'`))).not.toContain('zet-pass-123');
    expect(await getRawCredentials(c)).toMatchObject({ userId: 'zet-user', password: 'zet-pass-123', senderId: 'URBAN', source: 'database' });
    await saveCredentials(c, { password: 'new-pass', actor: 'admin' });
    expect(await getRawCredentials(c)).toMatchObject({ userId: 'zet-user', password: 'new-pass' });
    expect(await removeCredentials(c)).toMatchObject({ configured: false, hasUserId: false });
    expect(await getRawCredentials(c)).toBeNull();
  });
  it('can come from the environment instead, and a stored set wins over it', async () => {
    const envOnly = ctx(gateway(), { envCredentials: { userId: 'env-user', password: 'env-pass' } });
    expect(await getRawCredentials(envOnly)).toMatchObject({ userId: 'env-user', source: 'environment', senderId: '' });
    await saveCredentials(envOnly, { ...CREDS, actor: 'admin' });
    expect(await getRawCredentials(envOnly)).toMatchObject({ userId: 'zet-user', source: 'database' });
    await removeCredentials(envOnly);
  });
  it('cannot be stored without the secrets key', async () => {
    await expect(saveCredentials(ctx(gateway(), { secretsKey: undefined }), { ...CREDS, actor: 'admin' })).rejects.toMatchObject({ code: 'SECRETS_KEY_MISSING' });
  });
});

describe('queueing: nothing happens until it is switched on', () => {
  it('an order and a payment queue nothing while sms_enabled is off, and the database is otherwise unchanged', async () => {
    const o = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: 100_000 }] });
    await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'SKOFF00001', amountCents: 40_000, accountRef: o.orderRef });
    expect(await count()).toBe(0);
  });

  it('with it on, an order queues one text: first name, item, paybill and the order reference', async () => {
    await set({ sms_enabled: '1', paybill_number: '522533', business_name: 'Urban Trends', sms_delivery_promise: 'It will be delivered within the next 24 hours.' });
    const o = await newOrder(env, { customerName: 'Wanjiku Mwangi', customerPhone: '0712 345 001', items: [{ name: 'Red sneakers', quantity: 1, unitPriceCents: 250_000 }] });
    const m = (await q(`SELECT * FROM sms_outbox WHERE related_id = $1`, [o.orderRef]))[0];
    expect(m).toMatchObject({ template: 'order_received', to_phone: '254712345001', status: 'queued', attempts: 0, dedupe_key: `order_received:${o.orderRef}` });
    expect(m.body).toContain('Hi Wanjiku');
    expect(m.body).toContain('Red sneakers');
    expect(m.body).toContain(`Pay via Paybill 522533, Account ${o.orderRef}.`);
  });

  it('queueing the same event twice is one message', async () => {
    const o = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: 10_000 }] });
    const again = await queueOrderReceived(env.db.pool, { orderRef: o.orderRef, customerName: o.customerName, customerPhone: o.customerPhone, itemNames: ['Item'] });
    expect(again).toEqual({ queued: false, reason: 'duplicate' });
    expect(await count(`related_id = $1`, [o.orderRef])).toBe(1);
  });

  it('a payment queues a text with the balance, and the same notice arriving again queues nothing', async () => {
    const o = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: 100_000 }] });
    const notice = { transCode: 'SKPART0001', amountCents: 40_000, accountRef: o.orderRef };
    await ingestPaybillPayment({ pool: env.db.pool }, notice);
    const body = await lastBody();
    expect(body).toContain('payment of KES 400.');
    expect(body).toContain('Balance remaining: KES 600.');
    expect(body).toContain(`Account ${o.orderRef}`);
    const after = await fingerprint(env.db.pool);
    await ingestPaybillPayment({ pool: env.db.pool }, notice);
    await ingestPaybillPayment({ pool: env.db.pool }, notice);
    expect(await fingerprint(env.db.pool)).toEqual(after);

    await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'SKPART0002', amountCents: 60_000, accountRef: o.orderRef });
    expect(await lastBody()).toContain('Your order is fully paid.');
    expect(await count(`template = 'payment_received'`)).toBe(2);   // one per payment; the full one has no pay instructions, so it names no order
  });

  it('cash at the shop texts too; money with no order to attach to does not', async () => {
    const o = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: 50_000 }] });
    await recordShopCash({ pool: env.db.pool }, { orderRef: o.orderRef, amountCents: 50_000, reason: 'Customer walked in', actor: 'mona' });
    expect(await lastBody()).toContain('Your order is fully paid.');
    const before = await count();
    await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'SKNONE0001', amountCents: 5_000, accountRef: 'no such order' });
    expect(await count()).toBe(before);
  });

  it('each kind can be switched off on its own', async () => {
    await set({ sms_send_order_received: '0' });
    const before = await count();
    const o = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: 20_000 }] });
    expect(await count()).toBe(before);
    await set({ sms_send_order_received: '1', sms_send_payment_received: '0' });
    await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'SKOFF00002', amountCents: 20_000, accountRef: o.orderRef });
    expect(await count()).toBe(before);
    await set({ sms_send_payment_received: '1' });
  });

  it('a number that is not a Kenyan mobile is skipped, not queued', async () => {
    const before = await count();
    expect(await enqueue(env.db.pool, { toPhone: '0201234567', template: 'x', body: 'x' })).toEqual({ queued: false, reason: 'invalid_phone' });
    expect(await count()).toBe(before);
  });

  it('an order that does not happen sends nothing, and a lead turned into an order texts the customer', async () => {
    const phone = '0722 000 111';
    await newOrder(env, { customerPhone: phone, items: [{ name: 'Item', quantity: 1, unitPriceCents: 10_000 }] });
    const before = await count();
    await expect(newOrder(env, { customerPhone: phone, items: [{ name: 'Item', quantity: 1, unitPriceCents: 10_000 }] })).rejects.toMatchObject({ code: 'DUPLICATE_ACTIVE_ORDER' });
    expect(await count()).toBe(before);

    const { lead } = await createLead(env.db.pool, { name: 'Brian', phone: '0733 000 222', source: 'whatsapp', ...A });
    const { order } = await convertLead(env.db.pool, KEY, { id: lead.id, items: [{ name: 'Item', quantity: 1, unitPriceCents: 30_000 }], actor: 'mona' });
    expect((await q(`SELECT body FROM sms_outbox WHERE related_id = $1`, [order.orderRef]))[0].body).toContain('Hi Brian');
  });

  it('a messaging problem never stops an order or a payment from being saved', async () => {
    await q(`ALTER TABLE sms_outbox RENAME TO sms_outbox_off`);
    let o; let pay;
    try {
      o = await newOrder(env, { items: [{ name: 'Item', quantity: 1, unitPriceCents: 70_000 }] });
      pay = await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'SKBROKE001', amountCents: 70_000, accountRef: o.orderRef });
    } finally { await q(`ALTER TABLE sms_outbox_off RENAME TO sms_outbox`); }
    expect(o.status).toBe('awaiting_dispatch');
    expect(pay).toMatchObject({ outcome: 'applied' });
    expect(await count(`related_id = $1`, [o.orderRef])).toBe(0);
  });

  it('an order imported from an online store does not text the customer (as in the legacy system)', async () => {
    const s = await createSource(env.db.pool, { platform: 'shopify', name: 'S', shopDomain: 'a.myshopify.com', liveSyncEnabled: true });
    const p = await createProduct(env.db.pool, { sku: 'SMS-ON-1', name: 'Online', priceCents: 150_000, ...A });
    await receiveStock(env.db.pool, { productId: p.id, quantity: 5, ...A });
    const before = await count();
    const r = await importOnlineOrder({ pool: env.db.pool, refKey: KEY }, s, shopifyOrder(p.sku));
    expect(r.action).toBe('created');
    expect(await count()).toBe(before);
  });
});

describe('the worker', () => {
  const clear = async () => { await q(`DELETE FROM sms_outbox`); await q(`UPDATE alerts SET acknowledged_at = now(), acknowledged_by = 'test' WHERE kind = 'sms_failed' AND acknowledged_at IS NULL`); };
  const put = (n: number, over: Record<string, unknown> = {}) => Promise.all(Array.from({ length: n }, (_, i) => enqueue(env.db.pool, { toPhone: `07220000${String(i).padStart(2, '0')}`, template: 'test', body: `Message ${i}`, dedupeKey: `w:${Math.random()}:${i}`, ...over })));
  const withCreds = async () => { await saveCredentials(ctx(gateway()), { ...CREDS, actor: 'admin' }); };

  it('sends what is due, with the credentials, and records the gateway\'s reply', async () => {
    await clear(); await withCreds(); await put(3);
    const f = gateway(() => json({ status: 'success', id: 'abc' }));
    expect(await processOutbox(ctx(f))).toMatchObject({ sent: 3, retried: 0, failed: 0, expired: 0, waitingForCredentials: 0 });
    expect(f.calls).toHaveLength(3);
    // (The three were queued at the same moment, so which goes first is not promised: what is promised is that each goes once, with the account.)
    const sent = f.calls.map((c) => JSON.parse(c.body!) as { userid: string; password: string; senderid: string; sms: { mobile: string[]; msg: string }[] });
    expect(sent.every((b) => b.userid === 'zet-user' && b.password === 'zet-pass-123' && b.senderid === 'URBAN')).toBe(true);
    expect(sent.map((b) => `${b.sms[0]!.mobile[0]}|${b.sms[0]!.msg}`).sort()).toEqual(['254722000000|Message 0', '254722000001|Message 1', '254722000002|Message 2']);
    const rows = await q(`SELECT status, attempts, sent_at, provider_response FROM sms_outbox`);
    expect(rows.every((r) => r.status === 'sent' && r.attempts === 1 && r.sent_at && String(r.provider_response).includes('abc'))).toBe(true);
    expect(await processOutbox(ctx(f))).toMatchObject({ sent: 0 });          // nothing left; nothing sent twice
    expect(f.calls).toHaveLength(3);
  });

  it('with no credentials, messages wait untouched, and are sent once credentials arrive', async () => {
    await clear(); await removeCredentials(ctx(gateway())); await put(2);
    const f = gateway();
    expect(await processOutbox(ctx(f))).toMatchObject({ sent: 0, waitingForCredentials: 2 });
    expect(f.calls).toHaveLength(0);
    expect((await q(`SELECT DISTINCT status, attempts FROM sms_outbox`))).toEqual([{ status: 'queued', attempts: 0 }]);
    await withCreds();
    expect(await processOutbox(ctx(f))).toMatchObject({ sent: 2 });
  });

  it('a failed send is retried after a growing wait, and after five tries is given up on with an alert and can be retried by a person', async () => {
    await clear(); await withCreds(); await put(1);
    const f = gateway(() => json({ status: 'error', reason: 'No credit' }));
    const waits: number[] = [];
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      expect(await processOutbox(ctx(f))).toMatchObject({ retried: 1, failed: 0 });
      const r = (await q(`SELECT attempts, last_error, EXTRACT(EPOCH FROM (next_attempt_at - now())) AS wait FROM sms_outbox`))[0];
      expect(r).toMatchObject({ attempts: attempt, last_error: 'No credit' });
      waits.push(Math.round(Number(r.wait) / 60));
      expect(await processOutbox(ctx(f))).toMatchObject({ sent: 0, retried: 0 });   // not due yet: left alone
      await q(`UPDATE sms_outbox SET next_attempt_at = now()`);
    }
    expect(waits).toEqual([1, 5, 15, 60]);
    expect(await processOutbox(ctx(f))).toMatchObject({ failed: 1 });
    expect((await q(`SELECT status, attempts FROM sms_outbox`))[0]).toEqual({ status: 'failed', attempts: 5 });
    expect(await q(`SELECT kind FROM alerts WHERE kind = 'sms_failed' AND acknowledged_at IS NULL`)).toHaveLength(1);

    const id = Number((await q(`SELECT id FROM sms_outbox`))[0].id);
    expect(await retryMessage(env.db.pool, id)).toEqual({ id, status: 'queued' });
    expect((await q(`SELECT status, attempts, last_error FROM sms_outbox`))[0]).toEqual({ status: 'queued', attempts: 0, last_error: null });
    await expect(retryMessage(env.db.pool, id)).rejects.toMatchObject({ code: 'SMS_NOT_RETRYABLE' });
    await expect(retryMessage(env.db.pool, 999_999)).rejects.toMatchObject({ code: 'SMS_NOT_FOUND' });
  });

  it('a message still unsent after a day is dropped, not delivered late; retrying it makes it fresh', async () => {
    await clear(); await withCreds(); await put(2);
    await q(`UPDATE sms_outbox SET created_at = now() - interval '25 hours' WHERE body = 'Message 0'`);
    const f = gateway();
    expect(await processOutbox(ctx(f))).toMatchObject({ expired: 1, sent: 1 });
    expect(JSON.parse(f.calls[0]!.body!).sms[0].msg).toBe('Message 1');
    const stale = (await q(`SELECT id, status, last_error FROM sms_outbox WHERE body = 'Message 0'`))[0];
    expect(stale.status).toBe('expired');
    expect(stale.last_error).toContain('never delivered late');
    await retryMessage(env.db.pool, Number(stale.id));
    expect(await processOutbox(ctx(f))).toMatchObject({ sent: 1, expired: 0 });
  });

  it('a message stuck "sending" after a crash is put back and sent', async () => {
    await clear(); await withCreds(); await put(1);
    await q(`UPDATE sms_outbox SET status = 'sending', attempts = 1, updated_at = now() - interval '11 minutes'`);
    expect(await processOutbox(ctx(gateway()))).toMatchObject({ sent: 1 });
    await q(`UPDATE sms_outbox SET status = 'sending', updated_at = now() - interval '2 minutes' WHERE id = (SELECT max(id) FROM sms_outbox)`);
    expect(await processOutbox(ctx(gateway()))).toMatchObject({ sent: 0 });          // someone is working on that one right now
  });

  it('two workers at once send every message exactly once', async () => {
    await clear(); await withCreds(); await put(30);
    const seen = new Map<string, number>();
    const f = gateway(({ body }) => { const m = (body.sms as { msg: string }[])[0]!.msg; seen.set(m, (seen.get(m) ?? 0) + 1); return json({ status: 'success' }); });
    const results = await Promise.all([processOutbox(ctx(f)), processOutbox(ctx(f)), processOutbox(ctx(f))]);
    await processOutbox(ctx(f)); await processOutbox(ctx(f));
    expect(seen.size).toBe(30);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBeLessThanOrEqual(30);
    expect(await count(`status = 'sent'`)).toBe(30);
  });

  it('the schedule keeps sending while it runs, and really stops when told to', async () => {
    await clear(); await withCreds();
    const f = gateway();
    const job = scheduleSmsWorker(ctx(f), { everyMs: 20 });
    const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); };
    try {
      await put(1); await until(() => f.calls.length >= 1);
      expect(f.calls).toHaveLength(1);
      await put(1, { template: 'second' }); await until(() => f.calls.length >= 2);
      expect(f.calls).toHaveLength(2);
    } finally { job.stop(); }
    await new Promise((r) => setTimeout(r, 100));
    await put(1, { template: 'third' });
    await new Promise((r) => setTimeout(r, 250));
    expect(f.calls).toHaveLength(2);
  });
});

describe('a login code and a test message', () => {
  it('a one-time code is sent at once and never written to the outbox', async () => {
    await saveCredentials(ctx(gateway()), { ...CREDS, actor: 'admin' });
    const before = await count();
    const f = gateway();
    expect(await sendNow(ctx(f), '0712 345 678', 'Your code is 482913')).toEqual({ ok: true, error: null });
    expect(JSON.parse(f.calls[0]!.body!).sms[0]).toEqual({ mobile: ['254712345678'], msg: 'Your code is 482913' });
    expect(await count()).toBe(before);
    expect(await sendNow(ctx(f), '0201234567', 'x')).toEqual({ ok: false, error: 'invalid phone number' });
    expect(await sendNow(ctx(gateway(() => json({ status: 'failed', reason: 'bad sender' }))), '0712345678', 'x')).toEqual({ ok: false, error: 'bad sender' });
    await removeCredentials(ctx(f));
    expect(await sendNow(ctx(f), '0712345678', 'x')).toEqual({ ok: false, error: 'SMS is not configured' });
  });

  it('a test send reports the real outcome and the gateway\'s raw reply, with the number masked', async () => {
    await saveCredentials(ctx(gateway()), { ...CREDS, actor: 'admin' });
    const r = await sendTest(ctx(gateway(() => json({ status: 'success', id: 'T1' }))), '0712345678');
    expect(r).toMatchObject({ ok: true, to: '25471****678', providerResponse: expect.stringContaining('T1') });
    expect((await q(`SELECT status, template FROM sms_outbox WHERE template = 'test' ORDER BY id DESC LIMIT 1`))[0]).toEqual({ status: 'sent', template: 'test' });
    expect(await sendTest(ctx(gateway(() => json({ status: 'error', reason: 'No credit' }))), '0712345678')).toMatchObject({ ok: false, error: 'No credit' });
    await expect(sendTest(ctx(gateway()), '12345')).rejects.toMatchObject({ code: 'SMS_BAD_PHONE' });
  });
});

describe('the SMS screens', () => {
  const appWith = (f: FakeFetch) => createApp({ pool: env.db.pool, logger: createLogger('silent'), orderRefKey: KEY, secretsKey: SECRETS_KEY, sms: { fetch: f } });
  let app: ReturnType<typeof appWith>;
  beforeAll(() => { app = appWith(gateway()); });

  it('need a login; delivery needs sms.view; credentials need an administrator', async () => {
    expect((await request(app).get('/api/sms/status')).status).toBe(401);
    const cashier = await loggedIn(env.db.pool, 'cashier');
    for (const [m, u] of [['get', '/api/sms/status'], ['get', '/api/sms/outbox'], ['post', '/api/sms/outbox/1/retry'], ['get', '/api/sms/credentials'], ['put', '/api/sms/credentials'], ['delete', '/api/sms/credentials'], ['post', '/api/sms/test']] as const) {
      expect((await request(app)[m](u).set('Authorization', cashier.auth).send({})).status, `${m} ${u}`).toBe(403);
    }
    const manager = await loggedIn(env.db.pool, 'manager');
    expect((await request(app).get('/api/sms/status').set('Authorization', manager.auth)).status).toBe(200);
    expect((await request(app).get('/api/sms/credentials').set('Authorization', manager.auth)).status).toBe(403);   // a manager sees delivery, not the account
    expect((await request(app).put('/api/sms/credentials').set('Authorization', manager.auth).send(CREDS)).status).toBe(403);
  });

  it('an administrator manages the account, and the answers never contain a secret', async () => {
    const admin = await loggedIn(env.db.pool, 'admin'); const auth = admin.auth;
    await q(`DELETE FROM sms_outbox`); await removeCredentials(ctx(gateway()));
    expect((await request(app).put('/api/sms/credentials').set('Authorization', auth).send({ userId: 'u' })).status).toBe(422);
    expect((await request(app).put('/api/sms/credentials').set('Authorization', auth).send({ ...CREDS, extra: 1 })).status).toBe(422);
    const put = await request(app).put('/api/sms/credentials').set('Authorization', auth).send(CREDS);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ configured: true, source: 'database', hasUserId: true, hasPassword: true, senderId: 'URBAN' });
    const got = await request(app).get('/api/sms/credentials').set('Authorization', auth);
    expect(JSON.stringify(got.body)).not.toMatch(/zet-pass|zet-user/);
    expect((await q(`SELECT action, risk FROM audit_log WHERE action = 'sms_credentials_updated'`))[0]).toMatchObject({ risk: 2 });
    expect(JSON.stringify(await q(`SELECT details FROM audit_log WHERE action = 'sms_credentials_updated'`))).not.toContain('zet-pass');

    const t = await request(app).post('/api/sms/test').set('Authorization', auth).send({ to: '0712345678' });
    expect(t.body).toMatchObject({ ok: true, to: '25471****678' });
    expect((await request(app).post('/api/sms/test').set('Authorization', auth).send({})).status).toBe(422);

    const del = await request(app).delete('/api/sms/credentials').set('Authorization', auth);
    expect(del.body).toMatchObject({ configured: false });
  });

  it('shows the outbox with paging and a status filter, retries a failed message, and reports the week\'s counts', async () => {
    const admin = await loggedIn(env.db.pool, 'admin'); const auth = admin.auth;
    await q(`DELETE FROM sms_outbox`);
    for (let i = 0; i < 5; i++) await enqueue(env.db.pool, { toPhone: `07220001${i}0`, template: 'test', body: `M${i}`, dedupeKey: `ui:${i}` });
    await q(`UPDATE sms_outbox SET status = 'failed', last_error = 'No credit', attempts = 5 WHERE body IN ('M0', 'M1')`);
    const all = await request(app).get('/api/sms/outbox?limit=2&page=2').set('Authorization', auth);
    expect(all.body).toMatchObject({ total: 5, page: 2, limit: 2 });
    expect(all.body.messages.map((m: { body: string }) => m.body)).toEqual(['M2', 'M1']);                     // newest first
    const failed = await request(app).get('/api/sms/outbox?status=failed').set('Authorization', auth);
    expect(failed.body.total).toBe(2);
    expect((await request(app).get('/api/sms/outbox?status=bogus').set('Authorization', auth)).status).toBe(422);
    const status = await request(app).get('/api/sms/status').set('Authorization', auth);
    expect(status.body).toMatchObject({ enabled: true, last7Days: { queued: 3, failed: 2 } });

    const id = failed.body.messages[0].id;
    expect((await request(app).post(`/api/sms/outbox/${id}/retry`).set('Authorization', auth)).body).toEqual({ id, status: 'queued' });
    expect((await request(app).post(`/api/sms/outbox/${id}/retry`).set('Authorization', auth)).status).toBe(409);
    expect((await request(app).post('/api/sms/outbox/999999/retry').set('Authorization', auth)).status).toBe(404);
    expect((await request(app).post('/api/sms/outbox/abc/retry').set('Authorization', auth)).status).toBe(422);
  });
});

describe('after all of it, the money rules still hold', () => {
  it('the integrity check is clean', async () => { expect((await runIntegrityChecks(env.db.pool)).ok).toBe(true); });
});
