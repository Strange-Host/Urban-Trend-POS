const crypto = require('crypto');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const priceHistory = require('./priceHistory.service');

// Change the selling price of every product in a category in one go, and take it back in one go.
// The phone first asks for a PREVIEW (exact old and new price for every product), then sends APPLY with the preview's
// fingerprint. The server recomputes; if anything moved in between, the fingerprint no longer matches and nothing is applied.

const MAX_PRODUCTS = 1000;
const SHILLING = 100; // prices are cents; results are rounded to a whole shilling

// Nearest whole shilling, halves go up. The tiny epsilon keeps 12.5 -> 13 from being lost to floating point.
const toShilling = (cents) => Math.floor(cents / SHILLING + 0.5 + 1e-9) * SHILLING;

function newPrice(oldCents, mode, value) {
  const raw = mode === 'percent' ? (oldCents * (100 + value)) / 100 : oldCents + value;
  return toShilling(raw);
}

function plan({ categoryId, mode, value, includeInactive = false }) {
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw new ApiError(400, 'That category does not exist.', null, 'INVALID_CATEGORY');
  const rows = db.prepare(`
    SELECT id, name, sku, sell_price FROM products
    WHERE category_id = ? AND approval_status = 'approved' AND catalogue = 'shop' ${includeInactive ? '' : 'AND is_active = 1'}
    ORDER BY id
  `).all(categoryId);
  const items = []; const skipped = [];
  for (const p of rows) {
    const np = newPrice(p.sell_price, mode, value);
    if (np <= 0) skipped.push({ productId: p.id, name: p.name, reason: 'PRICE_NOT_POSITIVE' });
    else if (np === p.sell_price) skipped.push({ productId: p.id, name: p.name, reason: 'UNCHANGED' });
    else items.push({ productId: p.id, name: p.name, sku: p.sku, oldPriceCents: p.sell_price, newPriceCents: np, deltaCents: np - p.sell_price });
  }
  if (items.length > MAX_PRODUCTS) throw new ApiError(422, `That would change ${items.length} products; the limit is ${MAX_PRODUCTS}. Pick a smaller category.`, null, 'TOO_MANY');
  const fingerprint = crypto.createHash('sha256').update(items.map((i) => `${i.productId}:${i.oldPriceCents}:${i.newPriceCents}`).join('|')).digest('hex');
  return { fingerprint, count: items.length, skippedCount: skipped.length, items, skipped };
}

function apply(input, { userId, deviceId, reason }) {
  return db.transaction(() => {
    const p = plan(input);
    if (p.fingerprint !== input.fingerprint) {
      throw new ApiError(409, 'Prices changed since you previewed. Preview again before applying.', null, 'PREVIEW_STALE');
    }
    if (p.count === 0) throw new ApiError(422, 'Nothing would change.', null, 'NOTHING_TO_CHANGE');
    const batch = db.prepare(`INSERT INTO price_batches (kind, category_id, mode, value, reason, created_by, device_id, product_count) VALUES ('bulk', ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.categoryId, input.mode, input.value, reason, userId, deviceId, p.count);
    const batchId = Number(batch.lastInsertRowid);
    const upd = db.prepare(`UPDATE products SET sell_price = ?, updated_at = datetime('now') WHERE id = ?`);
    for (const i of p.items) {
      upd.run(i.newPriceCents, i.productId);
      priceHistory.record({ productId: i.productId, oldCents: i.oldPriceCents, newCents: i.newPriceCents, reason, userId, deviceId, batchId, source: 'bulk' });
    }
    return { batchId, count: p.count, appliedAt: new Date().toISOString() };
  })();
}

// A revert is a NEW batch that puts back the old price of every product still sitting at the price the batch gave it.
// A product someone has repriced since is left alone (and reported), so a revert can never undo a later, deliberate edit.
function revert(batchId, { userId, deviceId, reason }) {
  return db.transaction(() => {
    const original = db.prepare('SELECT * FROM price_batches WHERE id = ?').get(batchId);
    if (!original) throw new ApiError(404, 'Batch not found.', null, 'NOT_FOUND');
    if (original.kind !== 'bulk') throw new ApiError(409, 'Only a price change can be reverted, not a revert.', null, 'NOT_REVERTIBLE');
    if (original.reverted_by_batch_id) throw new ApiError(409, 'This batch was already reverted.', null, 'ALREADY_REVERTED');

    const lines = db.prepare(`
      SELECT h.product_id, h.old_price, h.new_price, p.name, p.sell_price AS current_price
      FROM price_history h JOIN products p ON p.id = h.product_id WHERE h.batch_id = ? ORDER BY h.id
    `).all(batchId);
    const toRevert = lines.filter((l) => l.current_price === l.new_price);
    const skipped = lines.filter((l) => l.current_price !== l.new_price).map((l) => ({ productId: l.product_id, name: l.name, reason: 'PRICE_CHANGED_SINCE' }));
    if (toRevert.length === 0) throw new ApiError(409, 'Every product has been repriced since, so there is nothing to revert.', null, 'NOTHING_TO_REVERT');

    const why = reason || `Reverted price change #${batchId}`;
    const batch = db.prepare(`INSERT INTO price_batches (kind, category_id, mode, value, reason, created_by, device_id, reverts_batch_id, product_count) VALUES ('bulk_revert', ?, 'revert', 0, ?, ?, ?, ?, ?)`)
      .run(original.category_id, why, userId, deviceId, batchId, toRevert.length);
    const newId = Number(batch.lastInsertRowid);
    const upd = db.prepare(`UPDATE products SET sell_price = ?, updated_at = datetime('now') WHERE id = ?`);
    for (const l of toRevert) {
      upd.run(l.old_price, l.product_id);
      priceHistory.record({ productId: l.product_id, oldCents: l.new_price, newCents: l.old_price, reason: why, userId, deviceId, batchId: newId, source: 'bulk_revert' });
    }
    db.prepare('UPDATE price_batches SET reverted_by_batch_id = ? WHERE id = ?').run(newId, batchId);
    return { batchId: newId, count: toRevert.length, skipped };
  })();
}

function listBatches({ beforeId = null, limit = 30 }) {
  const rows = db.prepare(`
    SELECT b.*, c.name AS category_name, u.name AS created_by_name, r.created_at AS reverted_at
    FROM price_batches b
    LEFT JOIN categories c ON c.id = b.category_id
    LEFT JOIN users u ON u.id = b.created_by
    LEFT JOIN price_batches r ON r.id = b.reverted_by_batch_id
    ${beforeId ? 'WHERE b.id < @beforeId' : ''}
    ORDER BY b.id DESC LIMIT @take
  `).all({ beforeId, take: limit + 1 });
  const more = rows.length > limit;
  return { rows: more ? rows.slice(0, limit) : rows, more };
}

module.exports = { plan, apply, revert, listBatches, newPrice, MAX_PRODUCTS };
