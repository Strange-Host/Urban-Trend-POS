const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const woocommerce = require('../config/woocommerce');

// Flattens WooCommerce's product/variation structure the same way
// shopify.service.js does for Shopify — one staging row per sellable
// variant, simple products becoming their own single "variant".
async function flattenVariants(client, products) {
  const rows = [];
  for (const product of products) {
    if (product.type === 'variable') {
      let page = 1;
      while (true) {
        const res = await client.get(`/products/${product.id}/variations`, { params: { per_page: 100, page } });
        for (const variation of res.data) {
          const attrs = (variation.attributes || []).map((a) => a.option).join(' / ');
          rows.push({
            shopify_product_id: String(product.id),
            shopify_variant_id: String(variation.id),
            shopify_inventory_item_id: null,
            sku: variation.sku || product.sku || null,
            barcode: null,
            name: attrs ? `${product.name} — ${attrs}` : product.name,
            sell_price: Math.round(parseFloat(variation.price || product.price || 0) * 100), // WooCommerce price is decimal string; staging.sell_price is cents
            inventory_qty: variation.stock_quantity ?? product.stock_quantity ?? 0,
            image_url: variation.image?.src || product.images?.[0]?.src || null,
            raw_json: JSON.stringify({ product_id: product.id, variation }),
          });
        }
        if (res.data.length < 100) break;
        page++;
      }
    } else {
      rows.push({
        shopify_product_id: String(product.id),
        shopify_variant_id: String(product.id),
        shopify_inventory_item_id: null,
        sku: product.sku || null,
        barcode: null,
        name: product.name,
        sell_price: Math.round(parseFloat(product.price || 0) * 100), // WooCommerce price is decimal string; staging.sell_price is cents
        inventory_qty: product.stock_quantity ?? 0,
        image_url: product.images?.[0]?.src || null,
        raw_json: JSON.stringify({ product }),
      });
    }
  }
  return rows;
}

async function pullFromWooCommerce(source, userId) {
  return ingestWooProducts(source, await woocommerce.fetchAllProducts(source), userId);
}

/** The staging upsert, shared by the full pull and by live webhooks (which deliver one product). */
async function ingestWooProducts(source, products, userId) {
  const client = woocommerce.getClient(source);
  const flat = await flattenVariants(client, products);
  const rows = flat.map((r) => ({ ...r, platform: 'woocommerce', income_source_id: source.id }));

  const upsert = db.prepare(`
    INSERT INTO shopify_staging_products
      (platform, income_source_id, shopify_product_id, shopify_variant_id, shopify_inventory_item_id, sku, barcode, name, sell_price, inventory_qty, image_url, raw_json, match_status, matched_product_id, review_status, fetched_at)
    VALUES (@platform, @income_source_id, @shopify_product_id, @shopify_variant_id, @shopify_inventory_item_id, @sku, @barcode, @name, @sell_price, @inventory_qty, @image_url, @raw_json, @match_status, @matched_product_id, 'pending', datetime('now'))
    ON CONFLICT(platform, COALESCE(income_source_id, 0), shopify_variant_id) DO UPDATE SET
      shopify_product_id = excluded.shopify_product_id,
      shopify_inventory_item_id = excluded.shopify_inventory_item_id,
      -- Same reasoning as the Shopify sync path: don't let a re-sync wipe
      -- out a SKU a reviewer already typed in, unless WooCommerce now has
      -- one of its own (more authoritative than a manual placeholder).
      sku = COALESCE(excluded.sku, shopify_staging_products.sku),
      barcode = excluded.barcode,
      name = excluded.name,
      sell_price = excluded.sell_price,
      inventory_qty = excluded.inventory_qty,
      image_url = excluded.image_url,
      raw_json = excluded.raw_json,
      match_status = excluded.match_status,
      matched_product_id = excluded.matched_product_id,
      -- category_id intentionally omitted — POS-only field, never sent by
      -- WooCommerce, must survive every re-sync untouched.
      -- Same as the Shopify sync path: a genuinely-changed already-approved
      -- row goes back to 'pending' so price/name changes made on the
      -- WooCommerce side actually reach the review queue again, instead of
      -- silently sitting in staging forever after the first approval.
      review_status = CASE
        WHEN shopify_staging_products.review_status = 'rejected' THEN 'pending'
        WHEN shopify_staging_products.review_status = 'approved' AND excluded.match_status = 'update' THEN 'pending'
        ELSE shopify_staging_products.review_status
      END,
      fetched_at = datetime('now')
  `);

  // Stock quantity auto-syncs on every pull regardless of review status —
  // see shopify.service.js for the reasoning (it's a fact, not a judgment
  // call, and stale counts are the most operationally damaging kind of drift).
  const syncInventoryForMatch = db.transaction((productId, incomingQty, userId) => {
    // A store can report negative stock (oversold there); the POS never holds below zero.
    const newQty = Math.max(0, incomingQty);
    const rows = db.prepare('SELECT * FROM inventory WHERE product_id = ?').all(productId);
    for (const inv of rows) {
      if (inv.quantity === newQty) continue;
      db.prepare(`UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE id = ?`).run(newQty, inv.id);
      db.prepare(`
        INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, created_by)
        VALUES (?, ?, ?, 'adjustment', ?)
      `).run(productId, inv.store_id, newQty - inv.quantity, userId || null);
    }
  });

  const txn = db.transaction((rows) => {
    let created = 0, updated = 0, unchanged = 0;
    for (const row of rows) {
      // Scoped to THIS income source — WooCommerce product/variation ids are
      // small sequential integers assigned per-site, so two different
      // WooCommerce stores very plausibly both have a "product 15". Without
      // this scope, syncing one store could match against and silently
      // overwrite a product that actually belongs to a different connected
      // store. SKU fallback stays unscoped on purpose: the same physical
      // product listed on more than one connected store should map to one
      // local product if it shares a SKU.
      const existing =
        db.prepare(`SELECT * FROM products WHERE shopify_variant_id = ? AND shopify_product_id = ? AND income_source_id IS ?`).get(row.shopify_variant_id, row.shopify_product_id, row.income_source_id) ||
        (row.sku && db.prepare('SELECT * FROM products WHERE sku = ?').get(row.sku));

      if (!existing) {
        row.match_status = 'new';
        row.matched_product_id = null;
        created++;
      } else {
        const changed = existing.name !== row.name || existing.sell_price !== row.sell_price;
        row.match_status = changed ? 'update' : 'unchanged';
        row.matched_product_id = existing.id;
        changed ? updated++ : unchanged++;
        syncInventoryForMatch(existing.id, row.inventory_qty, userId);
      }
      upsert.run(row);
    }
    return { created, updated, unchanged, total: rows.length };
  });

  const result = txn(rows);
  db.prepare(`UPDATE income_sources SET last_synced_at = datetime('now') WHERE id = ?`).run(source.id);
  return result;
}

module.exports = { pullFromWooCommerce, ingestWooProducts };
