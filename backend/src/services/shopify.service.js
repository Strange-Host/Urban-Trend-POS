const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { fetchAllProducts } = require('../config/shopify');
const { nextAutoSku } = require('../utils/autoSku');
const { decrypt } = require('../utils/crypto');

/**
 * Resolves the legacy env-var route (routes/shopify.routes.js) to the SAME
 * income_sources row the migration in db/migrate.js gives it on startup —
 * so a sync triggered from the old "Shopify sync" page and a sync
 * triggered from a configured income source use the identical
 * income_source_id, instead of one using NULL and silently creating
 * duplicate products for the same shop (see migrate.js's comment on
 * migrateLegacyShopifyEnvToIncomeSource for the full story). Returns
 * undefined only if SHOPIFY_SHOP was never set at all — a genuinely
 * unconfigured legacy route, not just an unmigrated one.
 */
function getLegacyEnvSource() {
  const shop = process.env.SHOPIFY_SHOP;
  if (!shop) return undefined;
  const normalizedShop = shop.trim().replace(/^https?:\/\//i, '').split('/')[0];
  const row = db.prepare('SELECT * FROM income_sources WHERE platform = ? AND shop_domain = ?').get('shopify', normalizedShop);
  if (!row) return undefined; // env var set but migration hasn't run yet (fresh DB mid-migrate) — config/shopify.js's own env fallback still covers this call
  row.access_token = decrypt(row.access_token);
  return row;
}

// Flattens Shopify's product/variant structure into one staging row per variant —
// this POS has no variant concept yet, so "Crew Tee, Blue, M" becomes its own SKU.
function flattenVariants(shopifyProducts) {
  const rows = [];
  for (const product of shopifyProducts) {
    for (const variant of product.variants) {
      const variantLabel = variant.title && variant.title !== 'Default Title'
        ? `${product.title} — ${variant.title}`
        : product.title;
      rows.push({
        shopify_product_id: String(product.id),
        shopify_variant_id: String(variant.id),
        shopify_inventory_item_id: variant.inventory_item_id ? String(variant.inventory_item_id) : null,
        sku: variant.sku || null,
        barcode: variant.barcode || null,
        name: variantLabel,
        // Shopify's price is a decimal string ("19.99") — staging.sell_price
        // is integer cents like every other money column now, so convert here.
        sell_price: Math.round(parseFloat(variant.price) * 100),
        inventory_qty: variant.inventory_quantity ?? 0,
        image_url: product.image?.src || null,
        raw_json: JSON.stringify({ product_id: product.id, variant }),
      });
    }
  }
  return rows;
}

/**
 * Pulls the full Shopify catalog and upserts it into the staging table.
 * Never touches the live `products` table — that only happens on approve().
 */
async function pullFromShopify(source, userId) {
  return ingestShopifyProducts(source, await fetchAllProducts(source), userId);
}

/** The staging upsert itself - shared by the full pull and by live webhooks, which deliver ONE product. */
function ingestShopifyProducts(source, shopifyProducts, userId) {
  const rows = flattenVariants(shopifyProducts).map((r) => ({
    ...r,
    platform: 'shopify',
    income_source_id: source?.id || null,
  }));

  const upsert = db.prepare(`
    INSERT INTO shopify_staging_products
      (platform, income_source_id, shopify_product_id, shopify_variant_id, shopify_inventory_item_id, sku, barcode, name, sell_price, inventory_qty, image_url, raw_json, match_status, matched_product_id, review_status, fetched_at)
    VALUES (@platform, @income_source_id, @shopify_product_id, @shopify_variant_id, @shopify_inventory_item_id, @sku, @barcode, @name, @sell_price, @inventory_qty, @image_url, @raw_json, @match_status, @matched_product_id, 'pending', datetime('now'))
    ON CONFLICT(platform, COALESCE(income_source_id, 0), shopify_variant_id) DO UPDATE SET
      shopify_product_id = excluded.shopify_product_id,
      shopify_inventory_item_id = excluded.shopify_inventory_item_id,
      -- If a reviewer already typed in a SKU while this row was pending,
      -- don't let a re-sync wipe it out just because Shopify/WooCommerce
      -- still doesn't have one — but if the platform DOES now have one
      -- (merchant added it there), that's the more authoritative source,
      -- so it wins.
      sku = COALESCE(excluded.sku, shopify_staging_products.sku),
      barcode = excluded.barcode,
      name = excluded.name,
      sell_price = excluded.sell_price,
      inventory_qty = excluded.inventory_qty,
      image_url = excluded.image_url,
      raw_json = excluded.raw_json,
      match_status = excluded.match_status,
      matched_product_id = excluded.matched_product_id,
      -- category_id is intentionally NOT in this SET clause — it's a
      -- POS-only field a reviewer assigns before approving, never sent by
      -- Shopify/WooCommerce, so it must survive every re-sync untouched.
      -- An already-approved row whose data has genuinely changed goes back to
      -- 'pending' so the change surfaces for review again — previously this
      -- silently sat in staging forever once first approved, meaning a price
      -- or name change made in Shopify after initial import NEVER reached the
      -- live catalog, no matter how many times you clicked "Sync." Rejected
      -- rows already got a second look this way; approved ones didn't.
      review_status = CASE
        WHEN shopify_staging_products.review_status = 'rejected' THEN 'pending'
        WHEN shopify_staging_products.review_status = 'approved' AND excluded.match_status = 'update' THEN 'pending'
        ELSE shopify_staging_products.review_status
      END,
      fetched_at = datetime('now')
  `);

  // Stock quantity isn't a judgment call the way price/name are — it's just a
  // fact, and stale counts are the most operationally damaging kind of drift
  // (overselling something that's actually out of stock, or refusing a sale
  // for something that's actually available). So unlike price/name changes,
  // already-approved products get their stock synced immediately on every
  // pull, no re-review needed — applied to every store that already tracks
  // inventory for that product (in practice, one store for the common
  // single-location setup).
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
      // Match against an already-imported product first (by shopify_variant_id,
      // scoped to the SAME income source — Shopify's ids are large enough that
      // two different Shopify stores essentially never collide, but this keeps
      // the same safe pattern WooCommerce needs below), then fall back to
      // matching by SKU (covers products created locally that happen to share
      // a SKU with the Shopify catalog, or the same physical product listed on
      // more than one connected store).
      const incomeSourceId = row.income_source_id;
      const existing =
        db.prepare('SELECT * FROM products WHERE shopify_variant_id = ? AND income_source_id IS ?').get(row.shopify_variant_id, incomeSourceId) ||
        (row.sku && db.prepare('SELECT * FROM products WHERE sku = ?').get(row.sku));

      if (!existing) {
        row.match_status = 'new';
        row.matched_product_id = null;
        created++;
      } else {
        const changed = existing.name !== row.name || existing.sell_price !== row.sell_price || existing.barcode !== row.barcode;
        row.match_status = changed ? 'update' : 'unchanged';
        row.matched_product_id = existing.id;
        changed ? updated++ : unchanged++;
        syncInventoryForMatch(existing.id, row.inventory_qty, userId);
      }
      upsert.run(row);
    }
    return { created, updated, unchanged, total: rows.length };
  });

  return txn(rows);
}

function listStaging(reviewStatus = 'pending', { platform, incomeSourceId } = {}) {
  const where = ['review_status = ?'];
  const params = [reviewStatus];
  if (platform) { where.push('platform = ?'); params.push(platform); }
  if (incomeSourceId !== undefined) { where.push('income_source_id IS ?'); params.push(incomeSourceId); }
  return db.prepare(`
    SELECT * FROM shopify_staging_products WHERE ${where.join(' AND ')} ORDER BY match_status DESC, name ASC
  `).all(...params);
}

/**
 * Approves one staged row: creates a new product or updates the matched one,
 * then seeds/updates its inventory for the given store. This is the only
 * place Shopify data is allowed to reach the live catalog.
 */
function approve(stagingId, storeId, userId) {
  const staged = db.prepare('SELECT * FROM shopify_staging_products WHERE id = ?').get(stagingId);
  if (!staged) throw new ApiError(404, 'Staged product not found.');
  if (staged.review_status !== 'pending') throw new ApiError(409, `Already ${staged.review_status}.`);

  const isNewProduct = !staged.matched_product_id;
  // A SKU is no longer required from the platform side — missing SKUs are
  // auto-assigned below. A category IS required for a genuinely new
  // product (an 'update' row updates an already-categorized product, so
  // no category decision is needed there).
  if (isNewProduct && !staged.category_id) {
    throw new ApiError(400, 'Assign a category before approving this new product.');
  }
  const sku = staged.sku || nextAutoSku();

  const txn = db.transaction(() => {
    let productId;
    if (staged.matched_product_id) {
      db.prepare(`
        UPDATE products SET
          name = ?, sell_price = ?, barcode = COALESCE(?, barcode),
          shopify_product_id = ?, shopify_variant_id = ?, shopify_inventory_item_id = ?,
          income_source_id = ?, shopify_synced_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(staged.name, staged.sell_price, staged.barcode, staged.shopify_product_id,
             staged.shopify_variant_id, staged.shopify_inventory_item_id, staged.income_source_id, staged.matched_product_id);
      productId = staged.matched_product_id;
    } else {
      const result = db.prepare(`
        INSERT INTO products (sku, barcode, name, category_id, cost_price, sell_price, tax_rate, image_url,
          shopify_product_id, shopify_variant_id, shopify_inventory_item_id, income_source_id, shopify_synced_at)
        VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?, datetime('now'))
      `).run(sku, staged.barcode, staged.name, staged.category_id, staged.sell_price, staged.image_url,
             staged.shopify_product_id, staged.shopify_variant_id, staged.shopify_inventory_item_id, staged.income_source_id);
      productId = result.lastInsertRowid;
    }

    const existingInventory = db.prepare('SELECT * FROM inventory WHERE product_id = ? AND store_id = ?').get(productId, storeId);
    if (existingInventory) {
      db.prepare(`UPDATE inventory SET quantity = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(Math.max(0, staged.inventory_qty), existingInventory.id);
    } else {
      db.prepare('INSERT INTO inventory (product_id, store_id, quantity) VALUES (?, ?, ?)')
        .run(productId, storeId, Math.max(0, staged.inventory_qty));
    }

    db.prepare(`
      INSERT INTO inventory_movements (product_id, store_id, change_qty, reason, created_by)
      VALUES (?, ?, ?, 'adjustment', ?)
    `).run(productId, storeId, staged.inventory_qty - (existingInventory?.quantity || 0), userId);

    db.prepare(`
      UPDATE shopify_staging_products SET sku = ?, review_status = 'approved', reviewed_at = datetime('now'), reviewed_by = ?, matched_product_id = ?
      WHERE id = ?
    `).run(sku, userId, productId, stagingId);

    return db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  });

  return txn();
}

function reject(stagingId, userId) {
  const result = db.prepare(`
    UPDATE shopify_staging_products SET review_status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ?
    WHERE id = ? AND review_status = 'pending'
  `).run(userId, stagingId);
  if (result.changes === 0) throw new ApiError(404, 'Staged product not found or already reviewed.');
}

/**
 * Lets a reviewer set/change the SKU and/or category on a pending staged
 * row before approving it — e.g. the Shopify/WooCommerce variant has no
 * SKU, or the auto-match picked the wrong category. Only pending rows can
 * be edited; once approved or rejected, the row is a historical record.
 */
function updateStaging(stagingId, { sku, category_id } = {}) {
  const staged = db.prepare('SELECT * FROM shopify_staging_products WHERE id = ?').get(stagingId);
  if (!staged) throw new ApiError(404, 'Staged product not found.');
  if (staged.review_status !== 'pending') throw new ApiError(409, `Already ${staged.review_status} — can't be edited.`);

  const sets = [];
  const params = { id: stagingId };

  if (sku !== undefined) {
    const trimmed = sku ? String(sku).trim() : null;
    if (trimmed) {
      const clash = db.prepare('SELECT id FROM products WHERE sku = ?').get(trimmed);
      if (clash) throw new ApiError(409, `SKU "${trimmed}" is already used by an existing product.`);
    }
    sets.push('sku = @sku');
    params.sku = trimmed;
  }
  if (category_id !== undefined) {
    const catId = category_id ? Number(category_id) : null;
    if (catId) {
      const cat = db.prepare('SELECT id FROM categories WHERE id = ?').get(catId);
      if (!cat) throw new ApiError(400, 'Category not found.');
    }
    sets.push('category_id = @category_id');
    params.category_id = catId;
  }

  if (sets.length === 0) return staged;
  db.prepare(`UPDATE shopify_staging_products SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return db.prepare('SELECT * FROM shopify_staging_products WHERE id = ?').get(stagingId);
}

module.exports = { pullFromShopify, ingestShopifyProducts, listStaging, approve, reject, updateStaging, getLegacyEnvSource };
