const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { todaySql } = require('../utils/storeTime');

// Shared by receiving, issuing, transfers and counts. Every change to inventory.quantity goes through
// applyMovement so it always writes its ledger row (inventory_movements) in the same transaction - the
// reconciliation job (services/reconciliation.service.js) checks the cache against that ledger.

const shopToday = () => db.prepare(`SELECT ${todaySql()} AS d`).get().d;

const isMainStore = (storeId) => Boolean(db.prepare('SELECT 1 FROM stores WHERE id = ? AND is_main = 1').get(storeId));
const getStore = (storeId) => db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);

function quantityOf(productId, storeId) {
  const row = db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, storeId);
  return row ? row.quantity : 0;
}

// THE one writer of stock. Nothing else in src/ may insert into or update inventory / inventory_movements
// (tests/characterization/stockWriters.test.js fails if it does). The only other write to inventory.quantity is
// resetCache() below, which repairs the cache from the ledger and deliberately writes no ledger row.
//
// Must run inside a transaction when more than one movement belongs together.
// batchId is only for stock that leaves FROM one named received batch (a recall, or writing off a named batch).
// shortfall is optional: when the change would take stock below zero, the caller can supply its own error instead of
// the default 409, so each screen keeps the wording and status code it always had.
//   shortfall({ onHand, hadRow, needed }) => ApiError
function applyMovement({ productId, storeId, change, reason, referenceType = null, referenceId = null, userId, batchId = null, shortfall = null }) {
  if (!Number.isInteger(change) || change === 0) throw new ApiError(400, 'A stock movement needs a non-zero whole number.');
  const existing = db.prepare('SELECT id, quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, storeId);
  if (existing) {
    if (existing.quantity + change < 0) {
      if (shortfall) throw shortfall({ onHand: existing.quantity, hadRow: true, needed: -change });
      const p = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
      throw new ApiError(409, `Not enough stock of "${p ? p.name : productId}": ${existing.quantity} on hand, ${-change} needed.`, null, 'INSUFFICIENT_STOCK');
    }
    db.prepare(`UPDATE inventory SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?`).run(change, existing.id);
  } else {
    if (change < 0) {
      if (shortfall) throw shortfall({ onHand: 0, hadRow: false, needed: -change });
      const p = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
      throw new ApiError(409, `Not enough stock of "${p ? p.name : productId}": 0 on hand, ${-change} needed.`, null, 'INSUFFICIENT_STOCK');
    }
    db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, ?, ?)').run(productId, storeId, change);
  }
  db.prepare(`
    INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, reference_type, reference_id, created_by, batch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(productId, storeId, change, reason, referenceType, referenceId, userId, batchId);
}

// Repairs drift: sets the cached quantity to a value the ledger says is right. The ONLY write to inventory.quantity that
// does not come with a ledger row, because the ledger is what it is being reconciled to (see reconciliation.service.js).
function resetCache({ productId, storeId, quantity }) {
  db.prepare(`UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ? AND store_id = ?`).run(quantity, productId, storeId);
}

// Registers a product at a store with zero on hand so it appears in that store's lists straight away. Not a movement:
// nothing changes hands, so there is no ledger row (zero adds nothing to the ledger sum). A no-op if the row exists.
function ensureRow(productId, storeId) {
  db.prepare('INSERT OR IGNORE INTO inventory (product_id, store_id, quantity) VALUES (?, ?, 0)').run(productId, storeId);
}

const inventoryRow = (productId, storeId) => db.prepare('SELECT * FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, storeId);

function parseQty(value, label = 'quantity') {
  if (!Number.isInteger(value) || value <= 0) throw new ApiError(400, `${label} must be a whole number above zero.`);
  return value;
}

// Dates arrive as YYYY-MM-DD from the screens; anything else is refused instead of being stored as text.
function parseDate(value, label = 'date') {
  if (value === undefined || value === null || value === '') return shopToday();
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, `${label} must look like 2026-10-30.`);
  }
  return value;
}

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

module.exports = { shopToday, isMainStore, getStore, quantityOf, applyMovement, resetCache, ensureRow, inventoryRow, parseQty, parseDate, trimmed };
