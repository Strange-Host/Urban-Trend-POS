const fs = require('fs');
const path = require('path');
const { cleanupTestDb } = require('../setup');

afterAll(() => cleanupTestDb());

// Guard rail for restructure stage R1 ("stock has exactly one writer").
//
// stock.service.applyMovement is the single writer of stock. This test fails if any other file under src/ (apart from
// migrations and the first-run seed) inserts into or updates inventory or inventory_movements. If a genuine new case
// appears, add a function to stock.service instead of adding a file to the allow-list.

const SRC = path.join(__dirname, '..', '..', 'src');
const STOCK_WRITE = /\b(UPDATE|DELETE\s+FROM|REPLACE\s+INTO|INSERT(\s+OR\s+\w+)?\s+INTO)\s+(inventory|inventory_movements)\b/i;

// R1 is complete: services/stock.service.js is the only file that writes inventory or inventory_movements.
const ALLOWED_DIRECT_WRITERS = [];
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

  it('the allow-list has no stale entries', () => {
    expect(ALLOWED_DIRECT_WRITERS.filter((a) => !writers.includes(a))).toEqual([]);
  });

  it('stock.service itself still writes both tables', () => {
    const src = fs.readFileSync(path.join(SRC, THE_WRITER), 'utf8');
    expect(src).toMatch(/UPDATE inventory/);
    expect(src).toMatch(/INSERT INTO inventory_movements/);
  });
});
