const fs = require('fs');
const path = require('path');
const { cleanupTestDb } = require('../setup');

afterAll(() => cleanupTestDb());

// Guard rail for restructure stage R1 ("stock has exactly one writer").
//
// Today stock.service.applyMovement is the intended single writer, and transfers, counts, receiving, batches and
// products already use it. Five other files still write the cache and ledger themselves. This test pins that exact
// list. It fails if a NEW file starts writing stock directly. R1 then empties this list one file at a time, and the
// final R1 commit sets ALLOWED_DIRECT_WRITERS to just [].

const SRC = path.join(__dirname, '..', '..', 'src');
const STOCK_WRITE = /(UPDATE|INSERT INTO|INSERT OR REPLACE INTO|DELETE FROM)\s+(inventory|inventory_movements)\b(?!_)|(UPDATE|INSERT INTO|DELETE FROM)\s+inventory_movements\b/;

const ALLOWED_DIRECT_WRITERS = [
  'controllers/inventory.controller.js',   // manual adjust
  'services/orders.service.js',            // dispatch and resellable return
  'services/sales.service.js',             // checkout and void
  'services/reconciliation.service.js',    // repairs cache drift (reads the ledger, resets the cache)
  'services/requisitions.service.js',      // approve requisition
];
const THE_WRITER = 'services/stock.service.js';
const IGNORED = ['db/migrate.js', 'db/seed.js'];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []
  );
}

describe('who is allowed to write stock', () => {
  const writers = walk(SRC)
    .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
    .filter((rel) => !IGNORED.includes(rel) && rel !== THE_WRITER)
    .filter((rel) => STOCK_WRITE.test(fs.readFileSync(path.join(SRC, rel), 'utf8')))
    .sort();

  it('no file outside the allow-list writes inventory or inventory_movements directly', () => {
    expect(writers.filter((w) => !ALLOWED_DIRECT_WRITERS.includes(w))).toEqual([]);
  });

  it('the allow-list has no stale entries (shrink it as R1 moves each writer over)', () => {
    expect(ALLOWED_DIRECT_WRITERS.filter((a) => !writers.includes(a))).toEqual([]);
  });

  it('stock.service itself still writes both tables', () => {
    const src = fs.readFileSync(path.join(SRC, THE_WRITER), 'utf8');
    expect(src).toMatch(/UPDATE inventory/);
    expect(src).toMatch(/INSERT INTO inventory_movements/);
  });
});
