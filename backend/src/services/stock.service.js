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

// Must run inside a transaction when more than one movement belongs together.
function applyMovement({ productId, storeId, change, reason, referenceType, referenceId, userId }) {
  if (!Number.isInteger(change) || change === 0) throw new ApiError(400, 'A stock movement needs a non-zero whole number.');
  const existing = db.prepare('SELECT id, quantity FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, storeId);
  if (existing) {
    if (existing.quantity + change < 0) {
      const p = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
      throw new ApiError(409, `Not enough stock of "${p ? p.name : productId}": ${existing.quantity} on hand, ${-change} needed.`, null, 'INSUFFICIENT_STOCK');
    }
    db.prepare(`UPDATE inventory SET quantity = quantity + ?, updated_at = datetime('now') WHERE id = ?`).run(change, existing.id);
  } else {
    if (change < 0) {
      const p = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
      throw new ApiError(409, `Not enough stock of "${p ? p.name : productId}": 0 on hand, ${-change} needed.`, null, 'INSUFFICIENT_STOCK');
    }
    db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, ?, ?)').run(productId, storeId, change);
  }
  db.prepare(`
    INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, reference_type, reference_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(productId, storeId, change, reason, referenceType, referenceId, userId);
}

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

module.exports = { shopToday, isMainStore, getStore, quantityOf, applyMovement, parseQty, parseDate, trimmed };
