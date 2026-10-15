const db = require('../config/db');
const logger = require('../utils/logger');

/**
 * inventory.quantity is a running cache, kept in sync inline by every
 * mutation (sale, void, adjust, requisition approval, Shopify/WooCommerce
 * sync) — each of those pairs its quantity change with an
 * inventory_movements row in the same transaction. That makes
 * SUM(inventory_movements.change_qty) an independent source of truth: if
 * the cached quantity and the ledger sum ever disagree, something wrote to
 * inventory.quantity without going through the normal paths (a bug, or
 * direct DB tampering) — a cheap, useful thing to be able to check.
 *
 * Returns an array of drifted rows: { product_id, store_id, product_name,
 * sku, cached_quantity, ledger_quantity, drift }. Empty array means
 * everything reconciles.
 */
function findDrift() {
  return db.prepare(`
    SELECT
      i.product_id, i.store_id, p.name AS product_name, p.sku,
      i.quantity AS cached_quantity,
      COALESCE(SUM(m.change_qty), 0) AS ledger_quantity,
      i.quantity - COALESCE(SUM(m.change_qty), 0) AS drift
    FROM inventory i
    JOIN products p ON p.id = i.product_id
    LEFT JOIN inventory_movements m ON m.product_id = i.product_id AND m.store_id = i.store_id
    GROUP BY i.product_id, i.store_id
    HAVING drift != 0
    ORDER BY ABS(drift) DESC
  `).all();
}

/**
 * Sets inventory.quantity to match the ledger sum for every drifted row.
 * Deliberately does NOT insert a new inventory_movements row for the fix —
 * the ledger is the trusted value being reconciled *to* here (it's built
 * exclusively by audited code paths; the cache is what's suspect), so
 * writing an extra movement to "explain" the correction would move the
 * ledger itself and just recreate the drift from the other direction. The
 * correction is logged instead, which is a real audit trail without
 * touching the ledger's meaning. Admin-triggered only — this overwrites
 * the cached quantity, which is exactly right if the ledger is correct and
 * wrong if the ledger itself is what's broken, so it's not run automatically.
 */
function reconcile() {
  const drifted = findDrift();
  if (drifted.length === 0) return [];

  const txn = db.transaction(() => {
    const updateQty = db.prepare(`UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE product_id = ? AND store_id = ?`);
    for (const row of drifted) {
      updateQty.run(Math.max(0, row.ledger_quantity), row.product_id, row.store_id);
    }
  });
  txn();

  logger.info(`[reconcile] fixed ${drifted.length} drifted inventory row(s)`, { rows: drifted });
  return drifted;
}

module.exports = { findDrift, reconcile };
