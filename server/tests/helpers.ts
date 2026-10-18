import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createPool, type Pool } from '../src/db/pool.js';

export interface TestDb {
  pool: Pool;
  url: string;
  drop: () => Promise<void>;
}

// A brand-new empty database, private to the calling test file.
export async function makeTestDb(): Promise<TestDb> {
  const adminUrl = inject('adminUrl');
  const name = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString(), { max: 5 });

  return {
    pool,
    url: url.toString(),
    drop: async () => {
      await pool.end();
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
