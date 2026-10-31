const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execSync } = require('child_process');
const Database = require('better-sqlite3');

// Upgrading a database that was created BEFORE main-store inventory control: the stores table gains is_main, and
// inventory_movements is rebuilt so it accepts the new movement kinds - with every existing row kept.
// The "before" schema is read from the last commit that predates this feature (e36707a).

const BACKEND = path.join(__dirname, '..');
let oldSchema = null;
try {
  oldSchema = execSync('git show e36707a:backend/src/db/schema.sql', { cwd: BACKEND, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 20 * 1024 * 1024 }).toString();
} catch { /* not a git checkout (or history trimmed): the test is skipped below */ }

const dbFile = path.join(os.tmpdir(), `utpos-migrate-${process.pid}-${Date.now()}.db`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile + s, { force: true }); };

const migrate = () => spawnSync('node', ['src/db/migrate.js'], {
  cwd: BACKEND, encoding: 'utf8',
  env: { ...process.env, DATABASE_PATH: dbFile, JWT_SECRET: 'x'.repeat(40), ENCRYPTION_KEY: 'y'.repeat(40), NODE_ENV: 'test' },
});

afterAll(cleanup);

(oldSchema ? describe : describe.skip)('upgrading an existing database', () => {
  it('adds is_main, widens the movement ledger, and keeps every existing row', () => {
    cleanup();
    const old = new Database(dbFile);
    old.exec(oldSchema);
    const storeId = old.prepare(`INSERT INTO stores (name) VALUES ('Old Shop')`).run().lastInsertRowid;
    old.prepare(`INSERT INTO stores (name) VALUES ('Second Shop')`).run();
    const productId = old.prepare(`INSERT INTO products (sku, name, sell_price) VALUES ('OLD-1', 'Old Thing', 1000)`).run().lastInsertRowid;
    old.prepare(`INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, ?, 5)`).run(productId, storeId);
    old.prepare(`INSERT INTO inventory_movements (product_id, store_id, change_qty, reason) VALUES (?, ?, 5, 'restock')`).run(productId, storeId);
    old.prepare(`INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, reference_type, reference_id) VALUES (?, ?, -1, 'sale', 'sale', 77)`).run(productId, storeId);
    expect(() => old.prepare(`INSERT INTO inventory_movements (product_id, store_id, change_qty, reason) VALUES (?, ?, 1, 'transfer_in')`).run(productId, storeId)).toThrow();
    old.close();

    const first = migrate();
    expect(first.status, first.stderr + first.stdout).toBe(0);

    const db = new Database(dbFile);
    // The oldest store became the main store; the other did not.
    expect(db.prepare('SELECT name, is_main FROM stores ORDER BY id').all()).toEqual([{ name: 'Old Shop', is_main: 1 }, { name: 'Second Shop', is_main: 0 }]);
    // Existing movements are untouched...
    expect(db.prepare('SELECT reason, change_qty, reference_type, reference_id FROM inventory_movements ORDER BY id').all()).toEqual([
      { reason: 'restock', change_qty: 5, reference_type: null, reference_id: null },
      { reason: 'sale', change_qty: -1, reference_type: 'sale', reference_id: 77 },
    ]);
    // ...and the new kinds are accepted, with their own reference types.
    const ins = db.prepare(`INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, reference_type, reference_id) VALUES (?, ?, 1, ?, ?, 1)`);
    for (const [reason, ref] of [['receipt', 'receipt'], ['issue', 'issue'], ['transfer_out', 'transfer'], ['transfer_in', 'transfer'], ['stocktake', 'stocktake']]) {
      expect(() => ins.run(productId, storeId, reason, ref)).not.toThrow();
    }
    expect(() => ins.run(productId, storeId, 'bogus', 'receipt')).toThrow();
    // Indexes survived the rebuild.
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'inventory_movements'`).all().map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(['idx_movements_product', 'idx_movements_reference']));
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();

    // Running it again changes nothing and does not fail.
    const second = migrate();
    expect(second.status, second.stderr + second.stdout).toBe(0);
    const again = new Database(dbFile);
    expect(again.prepare('SELECT COUNT(*) c FROM inventory_movements').get().c).toBe(2 + 5);
    expect(again.prepare('SELECT COUNT(*) c FROM stores WHERE is_main = 1').get().c).toBe(1);
    again.close();
  });
});
