const { cleanupTestDb } = require('./setup');
const db = require('../src/config/db');
const { dateOf, offsetMinutes } = require('../src/utils/storeTime');

afterAll(() => cleanupTestDb());

const tag = `${offsetMinutes() >= 0 ? 'p' : 'm'}${Math.abs(offsetMinutes())}`;

const insertSale = db.prepare(`
  INSERT INTO sales (store_id, cashier_id, subtotal, tax_total, discount_total, total, payment_method, status, created_at)
  VALUES (1, 1, 100, 0, 0, 100, 'cash', 'completed', ?)
`);

describe('shop-day expression indexes', () => {
  it('exist for the shop\'s current UTC offset on the report tables', () => {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx\\_%\\_day\\_%' ESCAPE '\\'").all().map((r) => r.name);
    for (const table of ['sales', 'orders', 'payments', 'payment_records', 'leads', 'inventory_movements']) {
      expect(names).toContain(`idx_${table}_day_${tag}`);
    }
  });

  it('are used by the real report filter, and the query result is identical to an unindexed scan', () => {
    // Sales around the shop-day boundary, in the shapes that really occur: SQLite's own UTC format, and the ISO-8601
    // strings (with an offset or Z) that Shopify / WooCommerce syncs store as-is.
    const stamps = [
      '2026-10-30 20:59:59', '2026-10-30 21:00:00', '2026-10-31 12:00:00', '2026-10-31 20:59:59', '2026-10-31 21:00:00',
      '2026-10-30T20:59:59Z', '2026-10-30T21:00:00Z', '2026-10-31T13:00:00-04:00', '2026-10-31T23:30:00+03:00',
      '2026-10-31T00:30:00+03:00', '2026-11-01T00:30:00+03:00', '2026-10-31T20:00:00',
    ];
    for (const s of stamps) insertSale.run(s);

    const where = `s.store_id = ? AND s.status = 'completed' AND ${dateOf('s.created_at')} BETWEEN ? AND ?`;
    const indexed = `SELECT s.id FROM sales s WHERE ${where} ORDER BY s.id`;
    const scanned = `SELECT s.id FROM sales s NOT INDEXED WHERE ${where} ORDER BY s.id`;

    const plan = db.prepare(`EXPLAIN QUERY PLAN ${indexed}`).all(1, '2026-10-31', '2026-10-31').map((r) => r.detail).join(' | ');
    expect(plan).toContain(`idx_sales_day_${tag}`);

    for (const [from, to] of [['2026-10-31', '2026-10-31'], ['2026-10-30', '2026-11-01'], ['2026-11-01', '2026-11-01']]) {
      const a = db.prepare(indexed).all(1, from, to).map((r) => r.id);
      const b = db.prepare(scanned).all(1, from, to).map((r) => r.id);
      expect(a).toEqual(b);
    }
    // Sanity: the filter really selects something and really excludes something.
    const day = db.prepare(indexed).all(1, '2026-10-31', '2026-10-31').length;
    expect(day).toBeGreaterThan(0);
    expect(day).toBeLessThan(stamps.length);
  });
});
