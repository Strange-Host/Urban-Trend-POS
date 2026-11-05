const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const { applyBaseline } = require('./baseline');
const { runMigrations, status, MigrationError } = require('./migrator');

// Entry point for `npm run migrate`, `npm start` and the tests: brings the database to the latest schema.
// Safe to run every time; it only does something when a migration is pending. See migrator.js and migrations/README.md.

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const BACKUP_DIR = path.join(path.dirname(process.env.DATABASE_PATH), 'backups');
const KEEP_PRE_MIGRATION_BACKUPS = 10;

// A consistent snapshot of the whole database, taken with SQLite's VACUUM INTO (synchronous, so the migration can wait
// for it). Owner-only like every other backup, and kept next to them so Settings lists it and it can be restored.
function backupBeforeMigrating({ db: handle, label }) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `pre-migration-${stamp}-${label}.db`);
  handle.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  try { fs.chmodSync(dest, 0o600); } catch (_) { /* not supported here */ }
  const old = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('pre-migration-') && f.endsWith('.db')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP_PRE_MIGRATION_BACKUPS))) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  return dest;
}

function migrate() {
  const result = runMigrations({ db, dir: MIGRATIONS_DIR, baseline: applyBaseline, backup: backupBeforeMigrating });
  if (result.applied.length === 0) console.log('Database is up to date.');
  return result;
}

if (process.argv.includes('--status')) {
  const s = status({ db, dir: MIGRATIONS_DIR });
  for (const r of s.applied) console.log(`  applied  ${String(r.version).padStart(4, '0')}_${r.name}  (${r.applied_at})`);
  for (const p of s.pending) console.log(`  pending  ${String(p.version).padStart(4, '0')}_${p.name}`);
  if (!s.applied.length && !s.pending.length) console.log('  no migrations');
} else {
  try {
    migrate();
  } catch (err) {
    if (err instanceof MigrationError) {
      console.error(`\nMigration stopped: ${err.message}\n`);
      if (require.main === module) process.exit(1);
    }
    throw err;
  }
}

module.exports = { migrate, MIGRATIONS_DIR };
