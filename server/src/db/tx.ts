import type pg from 'pg';
import type { Pool } from './pool.js';

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'>;

/** Runs fn in one transaction: commit if it returns, roll back if it throws. */
export async function withTransaction<T>(pool: Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
