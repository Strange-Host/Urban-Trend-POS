import pg from 'pg';

export type Pool = pg.Pool;

export function createPool(connectionString: string, opts: { ssl?: boolean; max?: number } = {}): Pool {
  return new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    ssl: opts.ssl ? { rejectUnauthorized: false } : undefined,
    // A query stuck behind a lock should fail loudly, not hang a request forever.
    statement_timeout: 30_000,
  });
}

// A fresh deploy can start before the database accepts connections (Railway brings services up in parallel).
// Retry briefly instead of failing the whole deploy; give up with the real error if it never comes up.
export async function waitForDatabase(pool: Pool, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (Date.now() + intervalMs > deadline) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
