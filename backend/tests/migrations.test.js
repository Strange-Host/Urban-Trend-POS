const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { runMigrations, status, checksumOf, MigrationError } = require('../src/db/migrator');

// Guard rail for restructure stage R3 ("versioned migrations").
//   1. The baseline (0001 = db/baseline.js + db/schema.sql) is frozen: a checksum pins both files.
//   2. The runner applies each numbered file once, in a transaction, and refuses an edited, missing, mis-numbered
//      or failing migration.
//   3. A fresh database and an older (pre-runner) database end up with the same schema, and a backup is taken
//      before anything pending runs on a database that already has data.

const DB_DIR = path.join(__dirname, '..', 'src', 'db');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(DB_DIR, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex');

describe('the baseline is frozen', () => {
  it('baseline.js and schema.sql are unchanged since R3', () => {
    // If this fails you edited a frozen file. Put the schema change in a new numbered file under db/migrations/.
    expect(sha('baseline.js')).toBe('e9e017b34521e65d4a5d39f595546acc96a763060fd6689d47fd7cc42fdfee1f');
    expect(sha('schema.sql')).toBe('47fdc958aac1b668c20c6ad43345bc426d03c78e9d1324f00c83d0daf5e726a5');
  });
});

describe('the migration runner', () => {
  let dir;
  let db;
  const quiet = () => {};
  const write = (name, sql) => fs.writeFileSync(path.join(dir, name), sql);
  const baseline = () => db.exec('CREATE TABLE IF NOT EXISTS base_t (id INTEGER PRIMARY KEY)');
  const run = (extra = {}) => runMigrations({ db, dir, baseline, log: quiet, ...extra });
  const versions = () => db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utpos-mig-'));
    db = new Database(':memory:');
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records the baseline as 0001 on a new database, then does nothing on the next run', () => {
    expect(run().applied).toEqual([1]);
    expect(versions()).toEqual([1]);
    expect(run().applied).toEqual([]);
  });

  it('applies numbered files in order, each exactly once', () => {
    write('0002_add_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    write('0003_add_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
    expect(run().applied).toEqual([1, 2, 3]);
    expect(run().applied).toEqual([]);        // a second CREATE TABLE would throw if it ran again
    write('0004_add_c.sql', 'CREATE TABLE c (id INTEGER PRIMARY KEY);');
    expect(run().applied).toEqual([4]);
    expect(versions()).toEqual([1, 2, 3, 4]);
  });

  it('a migration that fails keeps nothing of itself and stops, but keeps earlier ones', () => {
    write('0002_ok.sql', 'CREATE TABLE ok_t (id INTEGER PRIMARY KEY);');
    write('0003_bad.sql', 'CREATE TABLE half (id INTEGER PRIMARY KEY); INSERT INTO no_such_table VALUES (1);');
    expect(() => run()).toThrow(MigrationError);
    expect(versions()).toEqual([1, 2]);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ok_t'").get()).toBeTruthy();
    // fixing forward is a new number, so the broken file is replaced before it is ever recorded
    fs.rmSync(path.join(dir, '0003_bad.sql'));
    write('0003_fixed.sql', 'CREATE TABLE fixed_t (id INTEGER PRIMARY KEY);');
    expect(run().applied).toEqual([3]);
  });

  it('refuses a migration that was edited after it was applied', () => {
    write('0002_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    run();
    write('0002_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY, extra TEXT);');
    expect(() => run()).toThrow(/changed after it was applied/);
  });

  it('refuses a database that is newer than the code (applied file is missing)', () => {
    write('0002_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    run();
    fs.rmSync(path.join(dir, '0002_a.sql'));
    expect(() => run()).toThrow(/code is older than the database/);
  });

  it('refuses bad names, gaps, duplicates and a file numbered 0001', () => {
    write('0002_a.sql', 'SELECT 1;');
    write('0004_c.sql', 'SELECT 1;');
    expect(() => run()).toThrow(/without gaps/);
    fs.rmSync(path.join(dir, '0004_c.sql'));
    write('0002_other.sql', 'SELECT 1;');
    expect(() => run()).toThrow(/share the number 0002/);
    fs.rmSync(path.join(dir, '0002_other.sql'));
    write('add_things.sql', 'SELECT 1;');
    expect(() => run()).toThrow(/is not named like/);
    fs.rmSync(path.join(dir, 'add_things.sql'));
    write('0001_nope.sql', 'SELECT 1;');
    expect(() => run()).toThrow(/starts at 0002/);
  });

  it('refuses a new file numbered below one that is already applied', () => {
    write('0002_a.sql', 'SELECT 1;');
    write('0003_b.sql', 'SELECT 1;');
    run();
    db.prepare('DELETE FROM schema_migrations WHERE version = 2').run();   // as if 0002 had been added late on another branch
    expect(() => run()).toThrow(/numbered below migrations that are already applied/);
  });

  it('a checkout with Windows line endings has the same checksum', () => {
    expect(checksumOf('SELECT 1;\r\nSELECT 2;\r\n')).toBe(checksumOf('SELECT 1;\nSELECT 2;\n'));
  });

  it('takes a backup before pending work on a database that has data, and not on an empty one', () => {
    const backup = vi.fn(() => '/tmp/fake-backup.db');
    run({ backup });
    expect(backup).not.toHaveBeenCalled();             // brand new, nothing to protect

    write('0002_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    const res = run({ backup });
    expect(backup).toHaveBeenCalledTimes(1);
    expect(res.backupPath).toBe('/tmp/fake-backup.db');

    run({ backup });                                    // nothing pending: no backup
    expect(backup).toHaveBeenCalledTimes(1);
  });

  it('a failed migration names the backup so it can be restored', () => {
    run();
    write('0002_bad.sql', 'INSERT INTO no_such_table VALUES (1);');
    expect(() => run({ backup: () => '/tmp/before.db' })).toThrow(/\/tmp\/before\.db/);
  });

  it('status lists applied and pending without changing anything', () => {
    write('0002_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
    expect(status({ db, dir }).pending.map((p) => p.version)).toEqual([1, 2]);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get()).toBeUndefined();
    run();
    const s = status({ db, dir });
    expect(s.applied.map((a) => a.version)).toEqual([1, 2]);
    expect(s.pending).toEqual([]);
  });
});

describe('real database: fresh install vs a database from before the runner', () => {
  const MIGRATE = path.join(DB_DIR, 'migrate.js');
  const files = [];
  const tmp = (suffix) => { const f = path.join(os.tmpdir(), `utpos-r3-${process.pid}-${Date.now()}-${suffix}.db`); files.push(f); return f; };
  const migrate = (dbFile, args = []) => execFileSync(process.execPath, [MIGRATE, ...args], {
    env: { ...process.env, NODE_ENV: 'test', DATABASE_PATH: dbFile }, stdio: 'pipe',
  }).toString();
  const schemaOf = (dbFile) => {
    const d = new Database(dbFile, { readonly: true });
    try {
      return d.prepare("SELECT type, name, sql FROM sqlite_master WHERE name != 'schema_migrations' AND name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
    } finally { d.close(); }
  };

  afterAll(() => {
    for (const f of files) {
      for (const ext of ['', '-wal', '-shm']) fs.rmSync(f + ext, { force: true });
      fs.rmSync(path.join(path.dirname(f), 'backups'), { recursive: true, force: true });
    }
  });

  // The baseline plus every numbered file that ships in src/db/migrations, as the runner records them. Derived from the
  // folder, so adding 0003 later does not mean editing this test.
  const shipped = () => fs.readdirSync(path.join(__dirname, '..', 'src', 'db', 'migrations'))
    .map((f) => f.match(/^(\d{4})_(.+)\.sql$/))
    .filter(Boolean)
    .map((m) => ({ version: Number(m[1]), name: m[2] }))
    .sort((a, b) => a.version - b.version);

  it('a fresh database is recorded as the baseline plus each shipped migration, and a second run changes nothing', () => {
    const f = tmp('fresh');
    migrate(f);
    const d = new Database(f, { readonly: true });
    expect(d.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1, name: 'baseline' }, ...shipped()]);
    d.close();
    expect(migrate(f)).toContain('Database is up to date.');
  });

  it('a pre-runner database (no schema_migrations) reaches the same schema as a fresh one', () => {
    const fresh = tmp('same-fresh');
    migrate(fresh);

    const legacy = tmp('same-legacy');
    migrate(legacy);
    const d = new Database(legacy);
    d.exec('DROP TABLE schema_migrations');           // the shape every live database had before R3
    // A database from before the runner still has the HR columns that 0003 drops (the baseline re-adds the commission ones, not this one).
    try { d.exec("ALTER TABLE users ADD COLUMN onboarding_status TEXT NOT NULL DEFAULT 'active'"); } catch { /* already there */ }
    d.prepare("INSERT INTO settings (key, value) VALUES ('shop_note', 'kept') ON CONFLICT(key) DO NOTHING").run();
    d.close();

    migrate(legacy);
    expect(schemaOf(legacy)).toEqual(schemaOf(fresh));
    const after = new Database(legacy, { readonly: true });
    expect(after.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, ...shipped().map(({ version }) => ({ version }))]);
    expect(after.prepare("SELECT value FROM settings WHERE key = 'shop_note'").get().value).toBe('kept');   // data untouched
    after.close();
  });

  it('upgrading a database that has data leaves a restorable copy in backups/', () => {
    const f = tmp('backup');
    migrate(f);
    const d = new Database(f);
    d.exec('DROP TABLE schema_migrations');
    // A database from before the runner still has the HR columns that 0003 drops (the baseline re-adds the commission ones, not this one).
    try { d.exec("ALTER TABLE users ADD COLUMN onboarding_status TEXT NOT NULL DEFAULT 'active'"); } catch { /* already there */ }
    d.close();
    migrate(f);
    const dir = path.join(path.dirname(f), 'backups');
    const copies = fs.readdirSync(dir).filter((n) => n.startsWith('pre-migration-') && n.endsWith('.db'));
    expect(copies.length).toBeGreaterThan(0);
    const copy = new Database(path.join(dir, copies[copies.length - 1]), { readonly: true });
    expect(copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'users'").get().n).toBe(1);
    copy.close();
  });

  it('--status reports without changing the database', () => {
    const f = tmp('status');
    migrate(f);
    expect(migrate(f, ['--status'])).toMatch(/applied\s+0001_baseline/);
  });
});
