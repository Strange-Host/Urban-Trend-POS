import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { withIdempotency } from '../src/idempotency.js';
import { makeTestDb, type TestDb } from './helpers.js';

let db: TestDb;
beforeAll(async () => {
  db = await makeTestDb();
  await runMigrations(db.pool);
  await db.pool.query('CREATE TABLE side_effects (n serial PRIMARY KEY, note text)');
});
afterAll(() => db.drop());

const effects = async () => (await db.pool.query('SELECT count(*)::int AS n FROM side_effects')).rows[0].n as number;
const run = (key: string, request: unknown = { amount: 100 }) =>
  withIdempotency(db.pool, { scope: 'payments', key, request }, async (c) => {
    await c.query(`INSERT INTO side_effects (note) VALUES ($1)`, [key]);
    return { done: true, key };
  });

describe('withIdempotency', () => {
  it('runs once; a retry returns the first response without repeating the work', async () => {
    const first = await run('retry-key-0001');
    const second = await run('retry-key-0001');
    expect(first).toEqual({ result: { done: true, key: 'retry-key-0001' }, replayed: false });
    expect(second).toEqual({ result: { done: true, key: 'retry-key-0001' }, replayed: true });
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM side_effects WHERE note = 'retry-key-0001'`)).rows[0].n).toBe(1);
  });

  it('refuses the same key with a different request', async () => {
    await run('reuse-key-0001', { amount: 100 });
    await expect(run('reuse-key-0001', { amount: 999 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('keys are scoped: the same key in another scope is independent', async () => {
    await run('scoped-key-001');
    const other = await withIdempotency(db.pool, { scope: 'refunds', key: 'scoped-key-001', request: { amount: 100 } }, async () => 'ok');
    expect(other.replayed).toBe(false);
  });

  it('simultaneous requests with one key run the work exactly once', async () => {
    const before = await effects();
    const results = await Promise.all(Array.from({ length: 8 }, () => run('burst-key-0001')));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    for (const r of results) expect(r.result).toEqual({ done: true, key: 'burst-key-0001' }); // same content (jsonb may reorder keys)
    expect(await effects()).toBe(before + 1);
  });

  it('a failed attempt releases the key and leaves no side effects, so it can be retried', async () => {
    const before = await effects();
    await expect(withIdempotency(db.pool, { scope: 'payments', key: 'fail-key-00001', request: {} }, async (c) => {
      await c.query(`INSERT INTO side_effects (note) VALUES ('half-done')`);
      throw new Error('boom');
    })).rejects.toThrow(/boom/);
    expect(await effects()).toBe(before);
    expect((await run('fail-key-00001', {})).replayed).toBe(false);
  });

  it('rejects malformed keys', async () => {
    for (const bad of ['', 'short', 'has space in it', 'x'.repeat(201)]) {
      await expect(run(bad)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' });
    }
  });
});
