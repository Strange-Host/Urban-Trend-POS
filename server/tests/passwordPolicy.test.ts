import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { passwordProblems } from '../src/auth/passwordPolicy.js';
import { runMigrations } from '../src/db/migrate.js';
import { loggedIn } from './authHelpers.js';
import { makeTestDb, type TestDb } from './helpers.js';

// Ported from the legacy backend (sessionsAndLockout.test.js). The legacy Change password and Staff screens show these rules as
// live hints, so the new server has to enforce exactly them.
describe('password rules', () => {
  it('asks admins and managers for 12+ characters and cashiers for 8+', () => {
    expect(passwordProblems('Short-1pw', { role: 'admin' }).length).toBeGreaterThan(0);
    expect(passwordProblems('Short-1pw', { role: 'cashier' })).toEqual([]);
    expect(passwordProblems('Bluefin-Lantern-84', { role: 'manager' })).toEqual([]);
  });

  it('rejects common passwords, digit-only passwords, runs and passwords containing the person\'s name', () => {
    expect(passwordProblems('Password123!', { role: 'admin' }).join(' ')).toMatch(/common/);
    expect(passwordProblems('12345678', { role: 'cashier' }).join(' ')).toMatch(/digits/);
    expect(passwordProblems('qwertyuiop12', { role: 'admin' }).length).toBeGreaterThan(0);
    expect(passwordProblems('Mwangi-2026-tele', { role: 'cashier', displayName: 'Peter Mwangi' }).join(' ')).toMatch(/name/);
  });

  it('also rejects the shop\'s name, a repeated character, and the person\'s email, username or phone', () => {
    expect(passwordProblems('Urban-Trends-2026!', { role: 'manager' }).join(' ')).toMatch(/shop/);
    expect(passwordProblems('aaaaaaaaaaaaaa', { role: 'manager' }).join(' ')).toMatch(/repeated/);
    expect(passwordProblems('wanjiku-Fresh-77', { role: 'manager', email: 'wanjiku@shop.test' }).join(' ')).toMatch(/email/);
    expect(passwordProblems('kamau.k-Fresh-77', { role: 'manager', username: 'kamau.k' }).join(' ')).toMatch(/username/);
    expect(passwordProblems('Fresh-711222333-pw', { role: 'manager', phone: '0711 222 333' }).join(' ')).toMatch(/phone/);
  });

  it('does not mistake a short name fragment for the person', () => {
    expect(passwordProblems('Bluefin-Lantern-84', { role: 'manager', displayName: 'Jo Li', username: 'jo' })).toEqual([]);
  });

  it('answers with nothing wrong for an ordinary good password and a missing one with a reason', () => {
    expect(passwordProblems('Violet-Harbour-2291', { role: 'manager' })).toEqual([]);
    expect(passwordProblems(undefined, { role: 'cashier' }).length).toBeGreaterThan(0);
  });
});

describe('password rules, enforced when changing a password', () => {
  let db: TestDb;
  beforeAll(async () => { db = await makeTestDb(); await runMigrations(db.pool); });
  afterAll(() => db.drop());

  it('lists every problem for a manager and accepts a good one', async () => {
    const u = await loggedIn(db.pool, 'manager');
    const weak = await request(u.app).post('/api/auth/change-password').set('Authorization', u.auth).send({ currentPassword: u.password, newPassword: 'Password1!' });
    expect(weak.status).toBe(422);
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');
    expect(weak.body.error.message).toMatch(/Choose a stronger password/);
    expect(weak.body.details.problems.length).toBeGreaterThanOrEqual(2); // too short for a manager, and very common
    const ok = await request(u.app).post('/api/auth/change-password').set('Authorization', u.auth).send({ currentPassword: u.password, newPassword: 'Violet-Harbour-2291' });
    expect(ok.status).toBe(200);
  });

  it('is gentler on cashiers: 8 characters is enough, digits alone are not', async () => {
    const u = await loggedIn(db.pool, 'cashier');
    const digits = await request(u.app).post('/api/auth/change-password').set('Authorization', u.auth).send({ currentPassword: u.password, newPassword: '48291736' });
    expect(digits.body.error.code).toBe('WEAK_PASSWORD');
    const ok = await request(u.app).post('/api/auth/change-password').set('Authorization', u.auth).send({ currentPassword: u.password, newPassword: 'Mango-tree7' });
    expect(ok.status).toBe(200);
  });
});
