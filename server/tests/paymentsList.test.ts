import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { ingestPaybillPayment, recordShopCash } from '../src/orders/payments.js';
import { loggedIn } from './authHelpers.js';
import { KEY, makeEnv, newOrder, type Env } from './orderHelpers.js';

let env: Env;
let app: ReturnType<typeof createApp>;
beforeAll(async () => { env = await makeEnv(); app = createApp({ pool: env.db.pool, logger: createLogger('silent'), orderRefKey: KEY }); });
afterAll(() => env.db.drop());

describe('GET /api/payments (receipts)', () => {
  it('lists what has been booked against orders, newest first, with totals by method; filters and pages; managers only', async () => {
    const mgr = await loggedIn(env.db.pool, 'manager');
    const agent = await loggedIn(env.db.pool, 'cashier');
    const a = await newOrder(env);
    const b = await newOrder(env);
    await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'LST0000001', amountCents: 100_000, payerName: 'W', accountRef: a.orderRef });
    await recordShopCash({ pool: env.db.pool }, { orderRef: b.orderRef, amountCents: 50_000, reason: 'Paid at the counter', actor: 'mona' });
    const get = (q = '', u = mgr) => request(app).get(`/api/payments${q}`).set('Authorization', u.auth);

    expect((await get('', agent)).status).toBe(403);
    const all = await get();
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.receipts.map((r: { method: string }) => r.method)).toEqual(['cash', 'mpesa_paybill']);
    expect(all.body.receipts[1]).toMatchObject({ orderRef: a.orderRef, amountCents: 100_000, externalRef: 'LST0000001' });
    expect(all.body.summary.byMethod).toEqual([{ method: 'cash', totalCents: 50_000, count: 1 }, { method: 'mpesa_paybill', totalCents: 100_000, count: 1 }]);

    expect((await get('?method=cash')).body.total).toBe(1);
    expect((await get('?method=nonsense')).body.total).toBe(2);        // an unknown method filters nothing
    expect((await get(`?search=${a.orderRef}`)).body.receipts).toHaveLength(1);
    expect((await get('?limit=1&offset=1')).body.receipts).toHaveLength(1);
    expect((await get('?limit=1&offset=1')).body.total).toBe(2);
  });
});

describe('the suspense and cash-held lists the Reconciliation page reads', () => {
  it('shows an unmatched payment with its suggestions, applies it to an order, and lists and deposits held cash', async () => {
    const mgr = await loggedIn(env.db.pool, 'manager');
    const o = await newOrder(env);
    await ingestPaybillPayment({ pool: env.db.pool }, { transCode: 'SUS0000001', amountCents: o.totalCents, payerName: 'Someone', accountRef: 'no such code' });
    const list = await request(app).get('/api/payments/suspense').set('Authorization', mgr.auth);
    const item = list.body.items.find((i: { transCode: string }) => i.transCode === 'SUS0000001');
    expect(item).toMatchObject({ amountCents: o.totalCents, remainingCents: o.totalCents, payerName: 'Someone' });
    const sug = await request(app).get(`/api/payments/suspense/${item.exceptionId}/suggestions`).set('Authorization', mgr.auth);
    expect(sug.body.suggestions.map((s: { orderRef: string }) => s.orderRef)).toContain(o.orderRef);
    const applied = await request(app).post(`/api/payments/suspense/${item.exceptionId}/apply`).set('Authorization', mgr.auth).send({ orderRef: o.orderRef });
    expect(applied.status).toBe(200);
    expect((await request(app).get('/api/payments/suspense').set('Authorization', mgr.auth)).body.items.some((i: { transCode: string }) => i.transCode === 'SUS0000001')).toBe(false);

    const cashOrder = await newOrder(env);
    await recordShopCash({ pool: env.db.pool }, { orderRef: cashOrder.orderRef, amountCents: 20_000, reason: 'Paid in person', actor: mgr.username });
    const held = await request(app).get('/api/custody').set('Authorization', mgr.auth);
    const rec = held.body.records.find((r: { orderRef: string }) => r.orderRef === cashOrder.orderRef);
    expect(rec).toMatchObject({ amountCents: 20_000, holder: mgr.username });
    expect((await request(app).post(`/api/custody/${rec.id}/deposit`).set('Authorization', mgr.auth).send({})).status).toBe(200);
    expect((await request(app).get('/api/custody').set('Authorization', mgr.auth)).body.records.some((r: { id: number }) => r.id === rec.id)).toBe(false);
  });
});
