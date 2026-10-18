import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Pool } from './db/pool.js';
import { HttpError } from './errors.js';

const KEY_RE = /^[A-Za-z0-9_\-:.]{8,200}$/;

/**
 * Runs fn at most once per (scope, key). A retry with the same key and the same request returns the first response
 * without running fn again; the same key with a DIFFERENT request is refused.
 *
 * A replay returns the stored response as JSON, so it is equal in content to the first response but is the JSON
 * round-trip of it: dates come back as strings and object keys may be reordered. Return plain JSON-friendly data.
 *
 * The key is recorded in the same transaction as the work, so they commit or roll back together: if fn fails, the key
 * is free to be retried. Two simultaneous requests with one key are serialized by the database: the second waits for
 * the first to finish, then gets its stored result.
 */
export async function withIdempotency<T>(
  pool: Pool,
  opts: { scope: string; key: string; request: unknown },
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<{ result: T; replayed: boolean }> {
  if (!KEY_RE.test(opts.key)) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency key must be 8 to 200 characters: letters, digits, _ - : .');
  }
  const hash = createHash('sha256').update(JSON.stringify(opts.request ?? null)).digest('hex');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1, $2, $3) ON CONFLICT (scope, key) DO NOTHING`,
      [opts.scope, opts.key, hash]);

    if (ins.rowCount === 0) {
      const prior = await client.query<{ request_hash: string; response: T | null }>(
        `SELECT request_hash, response FROM idempotency_keys WHERE scope = $1 AND key = $2`, [opts.scope, opts.key]);
      await client.query('COMMIT');
      const row = prior.rows[0]!;
      if (row.request_hash !== hash) {
        throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'That idempotency key was already used with a different request.');
      }
      return { result: row.response as T, replayed: true };
    }

    const result = await fn(client);
    await client.query(`UPDATE idempotency_keys SET response = $3 WHERE scope = $1 AND key = $2`,
      [opts.scope, opts.key, JSON.stringify(result ?? null)]);
    await client.query('COMMIT');
    return { result, replayed: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
