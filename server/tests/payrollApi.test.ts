import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { loggedIn } from './authHelpers.js';
import { makeTestDb, type TestDb } from './helpers.js';
import { setPayProfile } from '../src/payroll/profiles.js';
import { clockIn } from '../src/payroll/attendance.js';
import { PERIOD } from './payrollHelpers.js';

let db: TestDb;
beforeAll(async () => { db = await makeTestDb(); await runMigrations(db.pool); });
afterAll(() => db.drop());

describe('payroll endpoints enforce who may do what', () => {
  it('rejects the whole payroll API without a login', async () => {
    const u = await loggedIn(db.pool, 'admin');
    for (const [m, p] of [['get', '/api/payroll/runs'], ['post', '/api/payroll/runs'], ['post', '/api/payroll/runs/1/approve'], ['post', '/api/payroll/runs/1/pay']] as const) {
      expect((await request(u.app)[m](p)).status, `${m} ${p}`).toBe(401);
    }
  });

  it('lets a cashier do nothing in payroll', async () => {
    const c = await loggedIn(db.pool, 'cashier');
    expect((await request(c.app).get('/api/payroll/runs').set('Authorization', c.auth)).status).toBe(403);
    expect((await request(c.app).post('/api/payroll/runs').set('Authorization', c.auth).send(PERIOD())).status).toBe(403);
  });

  it('lets a manager view and generate drafts but NOT approve or pay, whatever they put in the request', async () => {
    const m = await loggedIn(db.pool, 'manager');
    expect((await request(m.app).get('/api/payroll/runs').set('Authorization', m.auth)).status).toBe(200);
    const bad = await request(m.app).post('/api/payroll/runs').set('Authorization', m.auth).send({ from: 'yesterday', to: 'today' });
    expect(bad.status).toBe(422);
    const approve = await request(m.app).post('/api/payroll/runs/1/approve').set('Authorization', m.auth).send({ role: 'admin', actor: 'someone-else' });
    expect(approve.status).toBe(403);
    expect(approve.body.error.code).toBe('FORBIDDEN');
    expect((await request(m.app).post('/api/payroll/runs/1/pay').set('Authorization', m.auth).send({ method: 'cash' })).status).toBe(403);
  });

  it('runs the whole flow for an admin and records the logged-in person, not a name from the request', async () => {
    await setPayProfile(db.pool, { staffKey: 'wanjiku', dailyRetainerCents: 100_000, effectiveFrom: PERIOD().from, actor: 'seed' });
    await clockIn(db.pool, { staffKey: 'wanjiku' });
    const m = await loggedIn(db.pool, 'manager');
    const a = await loggedIn(db.pool, 'admin');
    const gen = await request(m.app).post('/api/payroll/runs').set('Authorization', m.auth).send({ ...PERIOD(), actor: 'spoofed' });
    expect(gen.status).toBe(201);
    expect(gen.body.run.createdBy).toBe(m.username);
    const id = gen.body.run.id;
    expect((await request(m.app).get(`/api/payroll/runs/${id}`).set('Authorization', m.auth)).body.run.status).toBe('draft');

    const approved = await request(a.app).post(`/api/payroll/runs/${id}/approve`).set('Authorization', a.auth).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.run.status).toBe('approved');
    expect(approved.body.run.approvedBy).toBe(a.username);

    expect((await request(a.app).post(`/api/payroll/runs/${id}/pay`).set('Authorization', a.auth).send({ method: 'mpesa' })).body.error.code).toBe('PAYOUT_REFERENCE_REQUIRED');
    const paid = await request(a.app).post(`/api/payroll/runs/${id}/pay`).set('Authorization', a.auth).send({ method: 'mpesa', paymentRef: 'QWE123' });
    expect(paid.status).toBe(200);
    expect(paid.body.run.status).toBe('paid');
    expect(paid.body.run.paidBy).toBe(a.username);
    expect((await request(a.app).get('/api/payroll/runs/abc').set('Authorization', a.auth)).status).toBe(422);
    expect((await request(a.app).get('/api/payroll/runs/987654').set('Authorization', a.auth)).status).toBe(404);
  });
});
