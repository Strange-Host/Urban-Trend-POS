// Shared helpers for the R0 characterization suite.
//
// "Characterization" means these tests pin what the system does TODAY for every money and stock path, so the
// restructure stages (R1 to R4) can move code around and prove nothing observable changed. They deliberately assert
// concrete numbers and ledger rows, not just status codes. If a restructure stage legitimately changes behaviour,
// the diff in these tests is the review artefact.

const { app, request, loginAsAdmin } = require('../setup');
const db = require('../../src/config/db');

const auth = (t) => ({ Authorization: `Bearer ${t}` });
let counter = 0;

async function admin() {
  const token = await loginAsAdmin();
  const me = db.prepare(`SELECT id, store_id FROM users WHERE email = 'admin@urbantrends.com'`).get();
  const mainId = db.prepare('SELECT id FROM stores WHERE is_main = 1').get().id;
  return { token, userId: me.id, mainId };
}

// A fresh, isolated product with a known cost, price and opening stock. Opening stock is written the same way the
// real paths do (cache + ledger together) so the ledger adds up from the first row.
function newProduct({ cost = 300, sell = 500, stock = 0, storeId = 1, name } = {}) {
  counter += 1;
  const pid = db.prepare(
    `INSERT INTO products (sku, name, cost_price, sell_price, is_active, approval_status) VALUES (?, ?, ?, ?, 1, 'approved')`
  ).run(`CH-${process.pid}-${counter}`, name || `Characterization ${counter}`, cost, sell).lastInsertRowid;
  if (stock > 0) {
    db.transaction(() => {
      db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, ?, ?)').run(pid, storeId, stock);
      db.prepare(`INSERT INTO inventory_movements (product_id, store_id, change_qty, reason) VALUES (?, ?, ?, 'restock')`).run(pid, storeId, stock);
    })();
  }
  return pid;
}

const cached = (pid, storeId = 1) => {
  const r = db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(pid, storeId);
  return r ? r.quantity : 0;
};
const ledgerSum = (pid, storeId = 1) =>
  db.prepare('SELECT COALESCE(SUM(change_qty), 0) AS s FROM inventory_movements WHERE product_id = ? AND store_id = ?').get(pid, storeId).s;

// Movements written after a mark, oldest first, in the exact shape the ledger stores them.
const mark = () => db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM inventory_movements').get().m;
const movementsSince = (m, pid) =>
  db.prepare(
    `SELECT store_id, change_qty AS change, reason, reference_type AS ref
     FROM inventory_movements WHERE id > ? AND product_id = ? ORDER BY id`
  ).all(m, pid);

// The one invariant every stock path must keep: the cached quantity equals the sum of the ledger.
function expectLedgerBalanced(pid, storeIds = [1]) {
  for (const s of storeIds) expect({ store: s, cached: cached(pid, s) }).toEqual({ store: s, cached: ledgerSum(pid, s) });
}

module.exports = { app, request, db, auth, admin, newProduct, cached, ledgerSum, mark, movementsSince, expectLedgerBalanced };
