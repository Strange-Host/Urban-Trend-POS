import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.js';
import { createLogger } from '../src/logger.js';
import { createPool, waitForDatabase } from '../src/db/pool.js';
import { makeTestDb, type TestDb } from './helpers.js';

let db: TestDb;
const logger = createLogger('silent');

beforeAll(async () => {
  db = await makeTestDb();
  await runMigrations(db.pool);
});
afterAll(() => db.drop());

describe('app on Postgres', () => {
  it('reports healthy with the number of applied migrations', async () => {
    const res = await request(createApp({ pool: db.pool, logger })).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'up', migrations: loadMigrationFiles().length });
  });

  it('returns 503 in the standard error shape when the database is unreachable', async () => {
    const dead = createPool('postgres://postgres:postgres@127.0.0.1:1/none', { max: 1 });
    try {
      const res = await request(createApp({ pool: dead, logger })).get('/api/health');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('DATABASE_UNAVAILABLE');
    } finally { await dead.end(); }
  });

  it('answers unknown routes and bad JSON with the standard error shape', async () => {
    const app = createApp({ pool: db.pool, logger });
    const missing = await request(app).get('/api/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');

    const bad = await request(app).post('/api/health').set('Content-Type', 'application/json').send('{not json');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_JSON');
  });
});

describe('config', () => {
  it('requires DATABASE_URL and names what is wrong', () => {
    expect(() => loadConfig({ NODE_ENV: 'test' })).toThrow(/DATABASE_URL/);
  });
  it('applies defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(c.PORT).toBe(3000);
    expect(c.DATABASE_SSL).toBe('false');
  });
});

describe('waitForDatabase', () => {
  it('returns as soon as the database answers', async () => {
    await expect(waitForDatabase(db.pool, { timeoutMs: 2000, intervalMs: 50 })).resolves.toBeUndefined();
  });
  it('gives up with the real connection error when the database never comes up', async () => {
    const dead = createPool('postgres://postgres:postgres@127.0.0.1:1/none', { max: 1 });
    try {
      await expect(waitForDatabase(dead, { timeoutMs: 300, intervalMs: 100 })).rejects.toThrow(/ECONNREFUSED/);
    } finally { await dead.end(); }
  });
});
