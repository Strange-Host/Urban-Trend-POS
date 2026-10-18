import pg from 'pg';

export type Pool = pg.Pool;

// Money is stored as bigint cents. node-postgres returns bigint as a string; turn it into a number, but refuse to
// silently lose precision if a value is ever outside the safe integer range.
const types = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === 20) {
      return (v: string) => {
        const n = Number(v);
        if (!Number.isSafeInteger(n)) throw new Error(`bigint value ${v} is outside the safe integer range`);
        return n;
      };
    }
    return pg.types.getTypeParser(oid, format as 'text');
  }) as typeof pg.types.getTypeParser,
};

export function createPool(connectionString: string, opts: { ssl?: boolean; max?: number } = {}): Pool {
  return new pg.Pool({
    connectionString,
    types,
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
