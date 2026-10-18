import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrationFiles, runMigrations } from '../src/db/migrate.js';
import { makeTestDb, type TestDb } from './helpers.js';

let db: TestDb;
const dirs: string[] = [];

beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => {
  await db.drop();
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function folder(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'utpos-mig-'));
  dirs.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(path.join(dir, name), sql);
  return dir;
}

const tableExists = async (name: string) =>
  (await db.pool.query('SELECT to_regclass($1) AS t', [`public.${name}`])).rows[0].t !== null;

describe('the real migrations folder', () => {
  it('is numbered contiguously and applies to an empty database, then is a no-op', async () => {
    const files = loadMigrationFiles();
    expect(files.length).toBeGreaterThan(0);

    const first = await runMigrations(db.pool);
    expect(first.applied).toEqual(files.map((f) => f.version));
    expect(await tableExists('settings')).toBe(true);

    const second = await runMigrations(db.pool);
    expect(second.applied).toEqual([]);
    expect(second.total).toBe(files.length);
  });
});

describe('migration runner rules', () => {
  it('refuses a gap or duplicate in numbering', () => {
    expect(() => loadMigrationFiles(folder({ '0001_a.sql': 'select 1', '0003_c.sql': 'select 1' }))).toThrow(/contiguous/);
    expect(() => loadMigrationFiles(folder({ '0001_a.sql': 'select 1', '0001_b.sql': 'select 1' }))).toThrow(/contiguous/);
  });

  it('refuses a badly named .sql file instead of silently skipping it', () => {
    expect(() => loadMigrationFiles(folder({ '0001_a.sql': 'select 1', 'fix-things.sql': 'select 1' }))).toThrow(/does not match/);
  });

  it('rolls back a failing migration completely and records nothing for it', async () => {
    const own = await makeTestDb();
    try {
      const dir = folder({
        '0001_ok.sql': 'CREATE TABLE ok_table (id int)',
        '0002_bad.sql': 'CREATE TABLE half_done (id int); SELECT 1/0;',
      });
      await expect(runMigrations(own.pool, dir)).rejects.toThrow(/0002_bad failed and was rolled back/);

      const t = async (n: string) => (await own.pool.query('SELECT to_regclass($1) AS t', [n])).rows[0].t !== null;
      expect(await t('ok_table')).toBe(true);        // 0001 stays applied
      expect(await t('half_done')).toBe(false);       // 0002 left nothing behind
      const versions = (await own.pool.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version);
      expect(versions).toEqual(['0001']);
    } finally { await own.drop(); }
  });

  it('refuses to run when an applied migration has been edited', async () => {
    const own = await makeTestDb();
    try {
      const dir = folder({ '0001_a.sql': 'CREATE TABLE a (id int)' });
      await runMigrations(own.pool, dir);
      writeFileSync(path.join(dir, '0001_a.sql'), 'CREATE TABLE a (id int, sneaky int)');
      await expect(runMigrations(own.pool, dir)).rejects.toThrow(/changed after it was applied/);
    } finally { await own.drop(); }
  });

  it('refuses when the database is ahead of the code', async () => {
    const own = await makeTestDb();
    try {
      await runMigrations(own.pool, folder({ '0001_a.sql': 'select 1', '0002_b.sql': 'select 1' }));
      await expect(runMigrations(own.pool, folder({ '0001_a.sql': 'select 1' }))).rejects.toThrow(/missing from the migrations folder/);
    } finally { await own.drop(); }
  });

  it('is safe when several instances start at once: each migration runs exactly once', async () => {
    const own = await makeTestDb();
    try {
      const dir = folder({ '0001_a.sql': 'CREATE TABLE once (id int); INSERT INTO once VALUES (1)' });
      const results = await Promise.all([1, 2, 3, 4].map(() => runMigrations(own.pool, dir)));
      expect(results.flatMap((r) => r.applied)).toEqual(['0001']); // applied by exactly one of the four
      expect((await own.pool.query('SELECT count(*)::int AS n FROM once')).rows[0].n).toBe(1);
    } finally { await own.drop(); }
  });
});
