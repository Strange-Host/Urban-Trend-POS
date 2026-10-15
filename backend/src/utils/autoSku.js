const db = require('../config/db');

// Auto-assigns sequential SKUs (1, 2, 3, ...) to products approved from
// Shopify/WooCommerce sync without one set on the platform side — so
// missing a SKU upstream no longer blocks approval. Stored as a plain
// counter in `settings` (key 'next_auto_sku') rather than derived by
// scanning existing SKUs for "the highest number used so far", since
// existing SKUs are free-text (e.g. "UT-TSH-001") and not safe to parse
// that way.
const SETTINGS_KEY = 'next_auto_sku';

/**
 * Atomically claims and returns the next auto-SKU as a string ("1", "2", …).
 * Skips forward past any number that's already in use as an SKU — belt-
 * and-braces against a manually created product coincidentally using a
 * plain numeric SKU like "3".
 */
const nextAutoSku = db.transaction(function nextAutoSku() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY);
    const n = row ? parseInt(row.value, 10) + 1 : 1;
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(SETTINGS_KEY, String(n));

    const collision = db.prepare('SELECT 1 FROM products WHERE sku = ?').get(String(n));
    if (!collision) return String(n);
    // Someone already used this number as a manual SKU — loop and claim the next one.
  }
  throw new Error('Could not find a free auto-SKU after 1000 attempts.');
});

module.exports = { nextAutoSku };
