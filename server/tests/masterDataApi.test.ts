import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';
import { loggedIn } from './authHelpers.js';
import { makeTestDb, type TestDb } from './helpers.js';
import { KEY } from './orderHelpers.js';

let db: TestDb;
let app: ReturnType<typeof createApp>;
beforeAll(async () => { db = await makeTestDb(); await runMigrations(db.pool); app = createApp({ pool: db.pool, logger: createLogger('silent'), orderRefKey: KEY }); });
afterAll(() => db.drop());

const as = (u: { auth: string }) => ({ set: (r: request.Test) => r.set('Authorization', u.auth) });

describe('master data endpoints: who may do what', () => {
  it('needs a login everywhere', async () => {
    for (const [m, p] of [['get', '/api/products'], ['post', '/api/products'], ['get', '/api/stock/movements'], ['get', '/api/customers'], ['get', '/api/leads'], ['post', '/api/leads/1/convert']] as const) {
      expect((await request(app)[m](p)).status, `${m} ${p}`).toBe(401);
    }
  });

  it('lets a cashier look things up and work leads, but not change the catalog, stock or flags', async () => {
    const c = await loggedIn(db.pool, 'cashier');
    const m = await loggedIn(db.pool, 'manager');
    const made = await as(m).set(request(app).post('/api/products')).send({ sku: 'tee-1', name: 'Tee', priceCents: 80_000 });
    expect(made.status).toBe(201);
    const id = made.body.product.id;
    expect((await as(c).set(request(app).get('/api/products'))).body.total).toBe(1);
    expect((await as(c).set(request(app).post('/api/products')).send({ sku: 'x', name: 'X', priceCents: 1 })).status).toBe(403);
    expect((await as(c).set(request(app).patch(`/api/products/${id}`)).send({ priceCents: 1 })).status).toBe(403);
    expect((await as(c).set(request(app).post(`/api/products/${id}/receive`)).send({ quantity: 5 })).status).toBe(403);
    expect((await as(c).set(request(app).post(`/api/products/${id}/adjust`)).send({ delta: -1, reason: 'x' })).status).toBe(403);
    expect((await as(c).set(request(app).put('/api/stock/strict')).send({ strict: true })).status).toBe(403);
    expect((await as(m).set(request(app).put('/api/stock/strict')).send({ strict: true })).status).toBe(403); // admin only
    expect((await as(c).set(request(app).get('/api/stock/movements'))).status).toBe(200);
  });

  it('runs the stock flow over HTTP, records the logged-in person, and answers bad input with a 422', async () => {
    const m = await loggedIn(db.pool, 'manager');
    const a = await loggedIn(db.pool, 'admin');
    const p = (await as(m).set(request(app).post('/api/products')).send({ sku: 'jean-1', name: 'Jeans', priceCents: 150_000, reorderLevel: 2 })).body.product;
    expect(p.sku).toBe('JEAN-1');
    expect((await as(m).set(request(app).post('/api/products')).send({ sku: 'jean-1', name: 'Dup', priceCents: 1 })).body.error.code).toBe('SKU_TAKEN');
    const rec = await as(m).set(request(app).post(`/api/products/${p.id}/receive`)).send({ quantity: 6, unitCostCents: 90_000, note: 'Supplier delivery' });
    expect(rec.body.onHand).toBe(6);
    expect((await as(m).set(request(app).post(`/api/products/${p.id}/write-off`)).send({ quantity: 7, reason: 'Lost' })).body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await as(m).set(request(app).post(`/api/products/${p.id}/adjust`)).send({ delta: 'a', reason: 'x' })).status).toBe(422);
    const mv = await as(m).set(request(app).get(`/api/stock/movements?productId=${p.id}`));
    expect(mv.body.movements[0]).toMatchObject({ type: 'receipt', quantity: 6, actor: m.username });
    // the jeans (6 in stock, reorder at 2) are fine; the out-of-stock tee from the other test is low
    expect((await as(m).set(request(app).get('/api/products?low=true'))).body.products.map((x: { sku: string }) => x.sku)).toEqual(['TEE-1']);
    expect((await as(a).set(request(app).put('/api/stock/strict')).send({ strict: true })).body.strict).toBe(true);
    expect((await as(m).set(request(app).get('/api/stock/strict'))).body.strict).toBe(true);
    expect((await as(m).set(request(app).get('/api/products?limit=abc'))).status).toBe(422);
    expect((await as(m).set(request(app).get('/api/products/999999'))).status).toBe(404);
  });

  it('works leads and customers end to end: enquiry, assign, convert, then the customer and their history appear', async () => {
    const c = await loggedIn(db.pool, 'cashier');
    const m = await loggedIn(db.pool, 'manager');
    const lead = await as(c).set(request(app).post('/api/leads')).send({ name: 'Amina', phone: '0711 000 999', source: 'whatsapp', message: 'Size 40 jeans?', channel: 'whatsapp' });
    expect(lead.status).toBe(201);
    const dup = await as(c).set(request(app).post('/api/leads')).send({ phone: '+254711000999', message: 'hello?' });
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    const id = lead.body.lead.id;
    expect((await as(c).set(request(app).put(`/api/leads/${id}/assignee`)).send({ assignedTo: c.username })).status).toBe(403); // managers assign
    expect((await as(m).set(request(app).put(`/api/leads/${id}/assignee`)).send({ assignedTo: c.username })).body.lead.assignedTo).toBe(c.username);
    expect((await as(c).set(request(app).put(`/api/leads/${id}/status`)).send({ status: 'lost' })).body.error.code).toBe('LEAD_LOST_REASON_REQUIRED');
    expect((await as(c).set(request(app).put(`/api/leads/${id}/status`)).send({ status: 'qualified' })).body.lead.status).toBe('qualified');

    const conv = await as(c).set(request(app).post(`/api/leads/${id}/convert`)).send({ items: [{ sku: 'JEAN-1', name: 'Jeans', quantity: 2, unitPriceCents: 150_000 }] });
    expect(conv.status).toBe(201);
    expect(conv.body.order.createdBy ?? conv.body.order.events[0].actor).toBe(c.username);
    expect(conv.body.lead).toMatchObject({ status: 'converted', convertedOrderRef: conv.body.order.orderRef });
    expect((await as(c).set(request(app).post(`/api/leads/${id}/convert`)).send({ items: [{ name: 'x', quantity: 1, unitPriceCents: 1 }] })).body.error.code).toBe('LEAD_CONVERTED');

    const found = await as(c).set(request(app).get('/api/customers/lookup?phone=0711000999'));
    expect(found.body.customer).toMatchObject({ name: 'Amina', stats: { orders: 1, active: 1 } });
    // only a manager can flag a customer
    expect((await as(c).set(request(app).put(`/api/customers/${found.body.customer.id}/prepay`)).send({ required: true, reason: 'x' })).status).toBe(403);
    const flagged = await as(m).set(request(app).put(`/api/customers/${found.body.customer.id}/prepay`)).send({ required: true, reason: 'Refused two parcels' });
    expect(flagged.body.customer).toMatchObject({ prepayRequired: true, prepayReason: 'Refused two parcels' });
    expect((await as(m).set(request(app).put(`/api/customers/${found.body.customer.id}/prepay`)).send({ required: true })).body.error.code).toBe('PREPAY_REASON_REQUIRED');
    expect((await as(c).set(request(app).get('/api/customers?prepay=true'))).body.total).toBe(1);
    expect((await as(c).set(request(app).get('/api/customers/lookup?phone=0799999999'))).body.customer).toBeNull();
  });

  it('answers a convert with 503 when the server has no ORDER_REF_KEY', async () => {
    const noKey = createApp({ pool: db.pool, logger: createLogger('silent') });
    const c = await loggedIn(db.pool, 'cashier');
    const lead = await as(c).set(request(noKey).post('/api/leads')).send({ name: 'Z', phone: '0733 111 222' });
    const res = await as(c).set(request(noKey).post(`/api/leads/${lead.body.lead.id}/convert`)).send({ items: [{ name: 'x', quantity: 1, unitPriceCents: 1_000 }] });
    expect(res.status).toBe(503);
  });
});
