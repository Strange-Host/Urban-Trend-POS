import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createUser } from '../src/auth/service.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';
import { makeTestDb, type TestDb } from './helpers.js';
import { loggedIn } from './authHelpers.js';
import { KEY } from './orderHelpers.js';
import { ingestPaybillPayment, recordShopCash } from '../src/orders/payments.js';

// The frontend adapters are tested against recorded answers of THIS server (frontend/src/api/adapters/__fixtures__). This test
// fails when the server's answers stop having the same shape as the recording, so a server change cannot quietly break a screen.
// Re-record on purpose with:  UPDATE_FIXTURES=1 npx vitest run tests/contractFixtures.test.ts
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/src/api/adapters/__fixtures__');
const UPDATE = process.env.UPDATE_FIXTURES === '1';

let db: TestDb;
beforeAll(async () => { db = await makeTestDb(); await runMigrations(db.pool); });
afterAll(() => db.drop());

/** The shape of a value: every string becomes "<string>", and so on. Arrays keep the shape of their first element. */
function shape(v: unknown): unknown {
  if (v === null) return '<null>';
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, shape(x)]));
  return `<${typeof v}>`;
}
/** Dates are strings on the wire; a null where a date may be is the same field. */
const sameShape = (a: unknown, b: unknown): void => { expect(JSON.stringify(shape(a)).replaceAll('"<null>"', '"<string>"')).toBe(JSON.stringify(shape(b)).replaceAll('"<null>"', '"<string>"')); };

function check(name: string, live: unknown): void {
  const file = path.join(DIR, `${name}.json`);
  if (UPDATE || !existsSync(file)) { mkdirSync(DIR, { recursive: true }); writeFileSync(file, `${JSON.stringify(live, null, 2)}\n`); return; }
  sameShape(live, JSON.parse(readFileSync(file, 'utf8')));
}

describe('what the staff screens read from the server', () => {
  it('keeps the sign-in, refresh, who-am-I, unlock and devices answers in the shape the recorded fixtures have', async () => {
    const app = createApp({ pool: db.pool, logger: createLogger('silent') });
    const { temporaryPassword } = await createUser(db.pool, { username: 'fixture.manager', displayName: 'Fixture Manager', role: 'manager', email: 'fixture@shop.test', actor: 'test-setup' });
    const first = await request(app).post('/api/auth/login').send({ email: 'fixture@shop.test', password: temporaryPassword });
    const pw = 'Violet-Harbour-2291'; // must satisfy the password rules, and not contain the account's own name
    await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${first.body.token}`).send({ currentPassword: temporaryPassword, newPassword: pw });

    const login = await request(app).post('/api/auth/login').send({ email: 'fixture@shop.test', password: pw, remember: true });
    const cookie = ([] as string[]).concat(login.headers['set-cookie'] ?? []).find((c) => c.startsWith('ut_refresh_token='))!.split(';')[0]!;
    const auth = `Bearer ${login.body.token}`;
    const refresh = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${refresh.body.token}`);
    const unlock = await request(app).post('/api/auth/unlock').set('Authorization', `Bearer ${refresh.body.token}`).send({ password: pw });
    const sessions = await request(app).get('/api/auth/sessions').set('Authorization', `Bearer ${refresh.body.token}`);
    const wrong = await request(app).post('/api/auth/login').send({ email: 'fixture@shop.test', password: 'wrong-wrong-1' });
    expect([login.status, refresh.status, me.status, unlock.status, sessions.status, wrong.status]).toEqual([200, 200, 200, 200, 200, 401]);
    void auth;

    const scrub = (b: Record<string, unknown>) => ({ ...b, ...(b.token ? { token: 'ACCESS_TOKEN' } : {}) });
    check('auth-login', scrub(login.body));
    check('auth-refresh', scrub(refresh.body));
    check('auth-me', me.body);
    check('auth-unlock', unlock.body);
    check('auth-sessions', sessions.body);
    check('auth-error', wrong.body);
  });
});

describe('what the Orders screen reads from the server', () => {
  it('keeps the list, an order out for delivery, a returned order and the courier list in the recorded shape', async () => {
    const app = createApp({ pool: db.pool, logger: createLogger('silent'), orderRefKey: KEY });
    const mgr = await loggedIn(db.pool, 'manager');
    const as = (r: request.Test) => r.set('Authorization', mgr.auth);
    const rider = (await as(request(app).post('/api/couriers/riders')).send({ name: 'Peter Rider', phone: '0700123456' })).body.courier;
    const make = async (phone: string) => (await as(request(app).post('/api/orders')).send({ customerName: 'Wanjiku', customerPhone: phone, items: [{ sku: 'FX-1', name: 'Canvas shoe', quantity: 2, unitPriceCents: 250_000 }] })).body.order.orderRef as string;
    const sent = await make('0755000001');
    await as(request(app).post(`/api/orders/${sent}/confirm`)).send({});
    await as(request(app).post(`/api/orders/${sent}/dispatch`)).send({ courierId: rider.id, packageFee: { amountCents: 30_000 } });
    const back = await make('0755000002');
    await as(request(app).post(`/api/orders/${back}/confirm`)).send({});
    await as(request(app).post(`/api/orders/${back}/dispatch`)).send({ courierId: rider.id, packageFee: { amountCents: 30_000 } });
    await as(request(app).post(`/api/orders/${back}/attempts`)).send({ outcome: 'refused', reason: 'Customer rejected the parcel' });
    const detail = (await as(request(app).get(`/api/orders/${back}`))).body.order;
    await as(request(app).post(`/api/orders/${back}/returned`)).send({ items: [{ orderItemId: detail.items[0].id, restockQuantity: 1, damagedQuantity: 1 }], notes: 'One pair scuffed' });

    const list = await as(request(app).get('/api/orders?limit=50'));
    const out = await as(request(app).get(`/api/orders/${sent}`));
    const returned = await as(request(app).get(`/api/orders/${back}`));
    const couriers = await as(request(app).get('/api/couriers?active=true'));
    expect([list.status, out.status, returned.status, couriers.status]).toEqual([200, 200, 200, 200]);
    expect(returned.body.order.status).toBe('returned');
    check('orders-list', list.body);
    check('order-out-for-delivery', out.body);
    check('order-returned', returned.body);
    check('couriers-list', couriers.body);
  });
});

describe('what the Finance screens read from the server', () => {
  it('keeps the receipts list, a suspense item with its suggestions, and the cash held in the recorded shape', async () => {
    const app = createApp({ pool: db.pool, logger: createLogger('silent'), orderRefKey: KEY });
    const mgr = await loggedIn(db.pool, 'manager');
    const as = (r: request.Test) => r.set('Authorization', mgr.auth);
    const make = async (phone: string) => (await as(request(app).post('/api/orders')).send({ customerName: 'Wanjiku', customerPhone: phone, items: [{ sku: 'FX-1', name: 'Canvas shoe', quantity: 2, unitPriceCents: 250_000 }] })).body.order.orderRef as string;
    const paid = await make('0755000011');
    const cashOrder = await make('0755000012');
    const waiting = await make('0755000013');
    await ingestPaybillPayment({ pool: db.pool }, { transCode: 'FIX0000001', amountCents: 200_000, payerName: 'Wanjiku', accountRef: paid });
    await ingestPaybillPayment({ pool: db.pool }, { transCode: 'FIX0000002', amountCents: 500_000, payerName: 'A friend', accountRef: 'no such code' });
    await recordShopCash({ pool: db.pool }, { orderRef: cashOrder, amountCents: 100_000, reason: 'Paid at the counter', actor: mgr.username });

    const receipts = await as(request(app).get('/api/payments?limit=50'));
    const suspense = await as(request(app).get('/api/payments/suspense'));
    const suggestions = await as(request(app).get(`/api/payments/suspense/${suspense.body.items[0].exceptionId}/suggestions`));
    const custody = await as(request(app).get('/api/custody'));
    expect([receipts.status, suspense.status, suggestions.status, custody.status]).toEqual([200, 200, 200, 200]);
    expect(suggestions.body.suggestions.map((s: { orderRef: string }) => s.orderRef)).toContain(waiting);
    check('payments-list', receipts.body);
    check('payments-suspense', suspense.body);
    check('payments-suggestions', suggestions.body);
    check('custody-list', custody.body);
  });
});
