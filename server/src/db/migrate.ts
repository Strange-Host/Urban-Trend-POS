import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Pool } from './pool.js';

// Numbered SQL migrations: migrations/0001_name.sql, 0002_name.sql, ...
//
// Rules the runner enforces, because money data depends on them:
//   - Numbers are contiguous from 0001 with no duplicates, so two branches cannot both claim 0007 unnoticed.
//   - An applied migration is never edited: its checksum is stored and compared on every run. Fix forward with a new file.
//   - Each migration runs in one transaction together with its bookkeeping row; a failure leaves nothing half-applied.
//   - A Postgres advisory lock makes concurrent starts (two Railway instances booting at once) safe: one migrates, the rest wait.

export const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

const LOCK_KEY = 727_401_001; // arbitrary constant unique to this app's migrations
const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrationFiles(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  const names = readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
  const files: MigrationFile[] = [];
  for (const file of names) {
    const m = FILE_RE.exec(file);
    if (!m) {
      if (file.endsWith('.sql')) throw new Error(`Migration file "${file}" does not match NNNN_name.sql (lowercase, digits, underscores).`);
      continue;
    }
    const sql = readFileSync(path.join(dir, file), 'utf8');
    files.push({ version: m[1]!, name: m[2]!, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  files.forEach((f, i) => {
    const expected = String(i + 1).padStart(4, '0');
    if (f.version !== expected) {
      throw new Error(`Migration numbering must be contiguous from 0001: expected ${expected}, found ${f.version}_${f.name}.sql.`);
    }
  });
  return files;
}

export interface MigrateResult {
  applied: string[]; // versions applied by this run
  total: number;     // versions applied overall, after this run
}

export async function runMigrations(pool: Pool, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrateResult> {
  const files = loadMigrationFiles(dir); // validate the folder before touching the database
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        name        text NOT NULL,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);

    const rows = await client.query<{ version: string; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version'
    );
    const done = new Map(rows.rows.map((r) => [r.version, r]));
    const known = new Set(files.map((f) => f.version));

    for (const r of rows.rows) {
      if (!known.has(r.version)) {
        throw new Error(`Database has migration ${r.version}_${r.name} that is missing from the migrations folder. Deploy the code that contains it.`);
      }
    }

    const applied: string[] = [];
    for (const f of files) {
      const existing = done.get(f.version);
      if (existing) {
        if (existing.checksum !== f.checksum) {
          throw new Error(`Migration ${f.version}_${f.name} was changed after it was applied. Never edit an applied migration; add a new one.`);
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(f.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [f.version, f.name, f.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${f.version}_${f.name} failed and was rolled back: ${(err as Error).message}`);
      }
      applied.push(f.version);
    }
    return { applied, total: done.size + applied.length };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
