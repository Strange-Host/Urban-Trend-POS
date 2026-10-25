import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Role } from '../src/auth/permissions.js';
import { runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';
import { loggedIn } from './authHelpers.js';
import { makeTestDb, type TestDb } from './helpers.js';
import { KEY } from './orderHelpers.js';

let db: TestDb;
let app: ReturnType<typeof createApp>;
beforeAll(async () => { db = await makeTestDb(); await runMigrations(db.pool); app = createApp({ pool: db.pool, logger: createLogger('silent'), orderRefKey: KEY }); });
afterAll(() => db.drop());

type M = 'get' | 'post' | 'put' | 'patch';
// [method, path, the lowest role allowed]. Every route in phases 3 to 6 is listed here, so a new route that forgets its guard
// is easy to spot, and a loosened guard fails a test.
const ROUTES: [M, string, Role][] = [
  // orders and money that needs a person
  ['get', '/api/orders', 'cashier'], ['get', '/api/orders/X', 'cashier'], ['post', '/api/orders', 'cashier'],
  ['post', '/api/orders/X/dispatch', 'manager'], ['post', '/api/orders/X/cancel', 'manager'], ['post', '/api/orders/X/attempts', 'manager'], ['post', '/api/orders/X/shop-cash', 'manager'], ['post', '/api/orders/X/returned', 'manager'],
  ['get', '/api/alerts', 'manager'], ['post', '/api/alerts/1/acknowledge', 'manager'],
  ['get', '/api/payments/suspense', 'manager'], ['get', '/api/payments/suspense/1/suggestions', 'manager'], ['post', '/api/payments/suspense/1/apply', 'manager'], ['post', '/api/payments/suspense/1/refund', 'manager'],
  ['get', '/api/custody', 'manager'], ['post', '/api/custody/1/deposit', 'manager'], ['get', '/api/at-risk', 'manager'],
  // couriers
  ['get', '/api/couriers', 'manager'], ['post', '/api/couriers/riders', 'manager'], ['post', '/api/couriers/organizations', 'manager'], ['put', '/api/couriers/1/active', 'manager'],
  ['get', '/api/couriers/costs', 'manager'], ['post', '/api/couriers/costs/1/approve', 'manager'], ['post', '/api/couriers/costs/1/reject', 'manager'],
  ['get', '/api/couriers/1', 'manager'], ['get', '/api/couriers/1/unpaid', 'manager'], ['get', '/api/couriers/1/open-collections', 'manager'],
  ['post', '/api/couriers/1/costs', 'manager'], ['post', '/api/couriers/1/payouts', 'admin'], ['post', '/api/couriers/1/collections', 'manager'], ['post', '/api/couriers/1/statements', 'manager'],
  // payroll
  ['get', '/api/payroll/runs', 'manager'], ['post', '/api/payroll/runs', 'manager'], ['post', '/api/payroll/runs/1/approve', 'admin'], ['post', '/api/payroll/runs/1/pay', 'admin'],
  ['get', '/api/payroll/plans', 'manager'], ['post', '/api/payroll/plans', 'admin'], ['get', '/api/payroll/profiles', 'manager'], ['post', '/api/payroll/profiles', 'admin'],
  ['get', '/api/payroll/adjustments', 'manager'], ['post', '/api/payroll/adjustments', 'manager'], ['post', '/api/payroll/attendance/absences', 'manager'],
  ['post', '/api/payroll/attendance/clock-in', 'cashier'], ['post', '/api/payroll/attendance/clock-out', 'cashier'], ['get', '/api/payroll/attendance', 'cashier'],
  ['get', '/api/payroll/salary', 'manager'], ['get', '/api/payroll/runs/1/export.csv', 'manager'],
  // till, sales, policy, audit, reports
  ['get', '/api/till/current', 'cashier'], ['post', '/api/till/sessions', 'cashier'], ['get', '/api/till/sessions', 'manager'], ['get', '/api/till/sessions/1', 'cashier'],
  ['post', '/api/till/sessions/1/movements', 'cashier'], ['post', '/api/till/sessions/1/close', 'cashier'], ['post', '/api/till/sessions/1/signoff', 'manager'],
  ['get', '/api/sales', 'cashier'], ['get', '/api/sales/1', 'cashier'], ['post', '/api/sales', 'cashier'], ['post', '/api/sales/1/void', 'cashier'], ['post', '/api/sales/1/refund', 'cashier'],
  ['get', '/api/discount-reasons', 'cashier'], ['post', '/api/discount-reasons', 'admin'], ['put', '/api/discount-reasons/x/active', 'admin'],
  ['get', '/api/discount-policies', 'manager'], ['put', '/api/discount-policies', 'admin'],
  ['get', '/api/audit', 'manager'], ['get', '/api/reports/discounts', 'manager'], ['get', '/api/reports/risky-actions', 'manager'], ['get', '/api/reports/trial-balance', 'manager'],
  ['get', '/api/integrity', 'manager'], ['post', '/api/integrity/run', 'admin'],
];
const RANK: Record<Role, number> = { cashier: 0, manager: 1, admin: 2 };

describe('every phase 3 to 6 route is guarded', () => {
  it('answers 401 with no login', async () => {
    for (const [m, p] of ROUTES) expect((await request(app)[m](p)).status, `${m} ${p}`).toBe(401);
  });

  it('answers 403 to every role below the one each route needs (and never 401/403 to a role that is allowed)', async () => {
    const users = { cashier: await loggedIn(db.pool, 'cashier'), manager: await loggedIn(db.pool, 'manager'), admin: await loggedIn(db.pool, 'admin') };
    for (const [m, p, min] of ROUTES) {
      for (const role of ['cashier', 'manager', 'admin'] as Role[]) {
        const res = await request(app)[m](p).set('Authorization', users[role].auth).send({});
        if (RANK[role] < RANK[min]) expect(res.status, `${role} ${m} ${p}`).toBe(403);
        else expect([401, 403], `${role} ${m} ${p} should be allowed in (got ${res.status} ${JSON.stringify(res.body.error)})`).not.toContain(res.status);
      }
    }
  });
});
