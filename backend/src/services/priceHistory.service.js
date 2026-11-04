const db = require('../config/db');

// One row per change to a product's SELLING price, whoever made it and wherever it was made (phone edit, bulk change,
// the web product screen, an approved online listing). The table is append-only: history is never edited, only added to.
// `deviceId` is the phone's sign-in session (auth_sessions.id), NULL for changes that did not come from a phone.
const SOURCES = ['edit', 'bulk', 'bulk_revert', 'online_sync', 'web'];

function record({ productId, oldCents, newCents, reason = null, userId = null, deviceId = null, batchId = null, source }) {
  if (!SOURCES.includes(source)) throw new Error(`Unknown price history source "${source}".`);
  if (oldCents === newCents) return null; // not a change
  const r = db.prepare(`
    INSERT INTO price_history (product_id, old_price, new_price, reason, changed_by, device_id, batch_id, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(productId, oldCents, newCents, reason, userId, deviceId, batchId, source);
  return r.lastInsertRowid;
}

// Newest first, keyset-paged on id so a page never repeats or skips a row when new changes arrive meanwhile.
function list(productId, { afterId = null, limit = 30 } = {}) {
  const rows = db.prepare(`
    SELECT h.id, h.old_price, h.new_price, h.reason, h.source, h.batch_id, h.changed_at, h.changed_by, u.name AS changed_by_name
    FROM price_history h LEFT JOIN users u ON u.id = h.changed_by
    WHERE h.product_id = @productId ${afterId ? 'AND h.id < @afterId' : ''}
    ORDER BY h.id DESC LIMIT @take
  `).all({ productId, afterId, take: limit + 1 });
  const more = rows.length > limit;
  return { rows: more ? rows.slice(0, limit) : rows, more };
}

module.exports = { record, list, SOURCES };
