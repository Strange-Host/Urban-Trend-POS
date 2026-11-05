const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Versioned migrations.
//
//   0001            the frozen baseline (baseline.js + schema.sql): brings any older database up to date. It is
//                   idempotent, so a database from before this runner existed simply runs it once and is then recorded.
//   0002 and later  numbered files in migrations/, NNNN_what_it_does.sql, each run exactly once inside a transaction.
//
// Applied versions are recorded in schema_migrations together with a checksum of the file, so an edited migration, a
// missing one, or a database newer than the code is refused at startup instead of silently drifting.
// Before anything pending runs on a database that already holds data, a copy of it is taken (see backup option).

const FILE_RE = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;
const BASELINE_VERSION = 1;

class MigrationError extends Error {
  constructor(message, { version = null, backupPath = null } = {}) {
    super(message);
    this.name = 'MigrationError';
    this.version = version;
    this.backupPath = backupPath;
  }
}

// Line endings are normalised so a checkout on Windows (CRLF) hashes the same as on the server (LF).
const checksumOf = (text) => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

function listMigrationFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.') || name.toLowerCase() === 'readme.md') continue;
    const m = FILE_RE.exec(name);
    if (!m) throw new MigrationError(`migrations/${name} is not named like 0002_what_it_does.sql (four digits, lowercase words, .sql).`);
    const version = Number(m[1]);
    if (version <= BASELINE_VERSION) throw new MigrationError(`migrations/${name}: numbering starts at 0002; 0001 is the frozen baseline.`);
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    found.push({ version, name: m[2], file: name, sql, checksum: checksumOf(sql) });
  }
  for (let i = 0; i < found.length; i++) {
    if (i > 0 && found[i].version === found[i - 1].version) {
      throw new MigrationError(`Two migrations share the number ${String(found[i].version).padStart(4, '0')}: ${found[i - 1].file} and ${found[i].file}.`);
    }
    const expected = BASELINE_VERSION + 1 + i;
    if (found[i].version !== expected) {
      throw new MigrationError(`Migrations must be numbered without gaps: expected ${String(expected).padStart(4, '0')} but found ${found[i].file}.`);
    }
  }
  return found;
}

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

const hasData = (db) => db.prepare(
  `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'`
).get().n > 0;

/**
 * Brings the database up to date.
 *   db        better-sqlite3 handle
 *   dir       folder of numbered .sql files
 *   baseline  function that applies the frozen baseline (idempotent)
 *   backup    optional ({ db, label }) => path; called once, before anything pending runs, on a database that has data
 *   log       logger (default console.log)
 * Returns { applied: [versions], backupPath }.
 */
function runMigrations({ db, dir, baseline, backup = null, log = console.log }) {
  const files = listMigrationFiles(dir);
  const existedBefore = hasData(db);
  ensureTable(db);

  const rows = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  const applied = new Map(rows.map((r) => [r.version, r]));
  const byVersion = new Map(files.map((f) => [f.version, f]));

  for (const r of rows) {
    if (r.version === BASELINE_VERSION) continue;
    const f = byVersion.get(r.version);
    if (!f) {
      throw new MigrationError(`This database has migration ${String(r.version).padStart(4, '0')}_${r.name} applied, but the file is not in migrations/. The code is older than the database: update the application, do not run it as it is.`, { version: r.version });
    }
    if (f.checksum !== r.checksum) {
      throw new MigrationError(`${f.file} was changed after it was applied. Applied migrations are never edited; put the change in a new numbered file.`, { version: r.version });
    }
  }
  const highest = rows.length ? rows[rows.length - 1].version : 0;
  const pendingFiles = files.filter((f) => !applied.has(f.version));
  if (pendingFiles.length && pendingFiles[0].version < highest) {
    throw new MigrationError(`${pendingFiles[0].file} is numbered below migrations that are already applied; renumber it after ${String(highest).padStart(4, '0')}.`, { version: pendingFiles[0].version });
  }

  const needBaseline = !applied.has(BASELINE_VERSION);
  const pending = [...(needBaseline ? [{ version: BASELINE_VERSION, name: 'baseline' }] : []), ...pendingFiles];
  if (pending.length === 0) return { applied: [], backupPath: null };

  let backupPath = null;
  if (backup && existedBefore) {
    const last = pending[pending.length - 1].version;
    backupPath = backup({ db, label: `to-${String(last).padStart(4, '0')}` });
    log(`  Backed up the database before migrating: ${backupPath}`);
  }

  const done = [];
  const record = db.prepare('INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)');
  try {
    if (needBaseline) {
      // The baseline manages its own table rebuilds (some need foreign keys off), so it is not wrapped here.
      baseline();
      record.run(BASELINE_VERSION, 'baseline', null);
      done.push(BASELINE_VERSION);
    }
    for (const f of pendingFiles) {
      // A migration that rebuilds a table should use PRAGMA defer_foreign_keys = ON (allowed inside a transaction).
      db.transaction(() => {
        db.exec(f.sql);
        record.run(f.version, f.name, f.checksum);
      })();
      log(`  Applied ${f.file}`);
      done.push(f.version);
    }
  } catch (err) {
    const where = err instanceof MigrationError ? '' : ` while applying ${String(pending[done.length] ? pending[done.length].version : '?').padStart(4, '0')}`;
    const note = backupPath ? ` A copy of the database from before this run is at ${backupPath}.` : '';
    throw new MigrationError(`Migration failed${where}: ${err.message}.${note} Nothing from the failed step was kept.`, { version: pending[done.length] && pending[done.length].version, backupPath });
  }
  return { applied: done, backupPath };
}

function status({ db, dir }) {
  const files = listMigrationFiles(dir);
  let rows = [];
  try { rows = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all(); } catch (_) { /* no table yet */ }
  const have = new Set(rows.map((r) => r.version));
  return {
    applied: rows,
    pending: [...(have.has(BASELINE_VERSION) ? [] : [{ version: BASELINE_VERSION, name: 'baseline' }]), ...files.filter((f) => !have.has(f.version)).map((f) => ({ version: f.version, name: f.name }))],
  };
}

module.exports = { runMigrations, status, listMigrationFiles, checksumOf, MigrationError, BASELINE_VERSION };
