const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const shopify = require('../config/shopify');
const woocommerce = require('../config/woocommerce');
const { fromUpstreamError } = require('../utils/upstreamError');

const crypto = require('crypto');
const logger = require('../utils/logger');

// First sync with no explicit depth. 60 is deliberate: it is exactly the window
// Shopify shows an app by default, so asking for more would silently return no
// more. Pick a longer depth from the "Sync sales" menu (and see the read_all_orders
// note in the result if Shopify still stops at 60 days).
const FALLBACK_LOOKBACK_DAYS = 60;
const SHOPIFY_DEFAULT_WINDOW_DAYS = 60;
const MAX_REPORTED_ERRORS = 5;

// Shopify/WooCommerce send money as decimal strings ("19.99") — every
// money column here is integer cents now, same as everywhere else.
function toCents(value) {
  return Math.round(parseFloat(value || 0) * 100);
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

// Finds (or creates) the local product a line item's SKU refers to. If
// nothing matches, we still never drop the sale - we create a minimal product
// row, kept OUT of the POS (is_active = 0), so the item shows up correctly in
// Sales History and analytics instead of silently vanishing.
//
// The placeholder SKU is a hash of the FULL product name. It used to be the first
// 16 base64 characters (= the first 12 BYTES of the name), so "Leather Office
// Chair Black" and "Leather Office Chair Brown" got the same SKU and every later
// sale of either was silently booked against whichever was imported first.
function resolveProduct(sku, name, price) {
  const safeName = String(name || 'Online item').trim() || 'Online item';
  if (sku) {
    const bySku = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
    if (bySku) return bySku.id;
  }
  const placeholderSku = sku || `EXT-${crypto.createHash('sha1').update(safeName.toLowerCase()).digest('hex').slice(0, 12).toUpperCase()}`;
  const existingPlaceholder = db.prepare('SELECT * FROM products WHERE sku = ?').get(placeholderSku);
  if (existingPlaceholder) return existingPlaceholder.id;

  // Placeholders made by earlier versions used the truncated-base64 SKU. Reuse one
  // only when the NAME matches exactly, so old data keeps working without ever
  // merging two different products.
  if (!sku) {
    const legacySku = `EXT-${Buffer.from(safeName).toString('base64').slice(0, 16)}`;
    const legacy = db.prepare('SELECT * FROM products WHERE sku = ? AND name = ?').get(legacySku, safeName);
    if (legacy) return legacy.id;
  }

  const result = db.prepare(`
    INSERT INTO products (sku, name, cost_price, sell_price, tax_rate, is_active, description)
    VALUES (?, ?, 0, ?, 0, 0, 'Auto-created from an online order - no matching local SKU was found.')
  `).run(placeholderSku, safeName, price || 0);
  return result.lastInsertRowid;
}

// Which POS location an online channel's sales belong to. Sales History, reports
// and the dashboard only show the signed-in user's OWN store, so imported orders
// have to land there. This used to create a brand-new store named after the
// income source whenever none was set (and the Settings form never set one) -
// the sync then reported "Imported 25 of 25" while Sales History stayed empty,
// because the sales sat under a store nobody was signed in to.
function ensureOnlineStore(source, fallbackStoreId) {
  if (source.store_id) return source.store_id;
  if (!fallbackStoreId) throw new ApiError(400, 'This income source has no store assigned and no signed-in store to use.');
  db.prepare('UPDATE income_sources SET store_id = ? WHERE id = ?').run(fallbackStoreId, source.id);
  return fallbackStoreId;
}

// One-time repair for sources that already synced under the invented store:
// move their sales onto the real one. Idempotent - a no-op once nothing is stray.
function adoptStraySales(source, storeId) {
  return db.prepare('UPDATE sales SET store_id = ? WHERE income_source_id = ? AND store_id != ?')
    .run(storeId, source.id, storeId).changes;
}

function findImported(incomeSourceId, externalOrderId) {
  return db.prepare('SELECT id, status, total, external_updated_at FROM sales WHERE income_source_id = ? AND external_order_id = ?')
    .get(incomeSourceId, String(externalOrderId));
}

function shopifyStatus(order) {
  return order.cancelled_at ? 'voided' : order.financial_status === 'refunded' ? 'refunded' : 'completed';
}

function wooStatus(order) {
  return ['cancelled', 'trash'].includes(order.status) ? 'voided' : order.status === 'refunded' ? 'refunded' : 'completed';
}

// The Orders-page importer (shopifyOrders.service.js) and Sync sales can each see an
// online order first. Whichever runs second links the two records: the SALE is what
// reports count for revenue, the ORDER is what staff dispatch - never both for revenue.
function linkFulfilmentOrder(incomeSourceId, saleId, externalOrderId) {
  db.prepare('UPDATE orders SET sale_id = ? WHERE income_source_id = ? AND external_order_id = ? AND sale_id IS NULL')
    .run(saleId, incomeSourceId, externalOrderId);
}

// An order we already imported can change afterwards (cancelled, refunded,
// repriced). Re-syncing used to skip it outright, so those changes never reached
// the POS and cancelled orders kept counting as revenue.
function refreshExisting(existing, newStatus, newTotal, updatedAt) {
  // A webhook can arrive out of order (an older "paid" after a newer "cancelled"). If we already hold a
  // newer version of this order, the late one must not drag it backwards.
  if (updatedAt && existing.external_updated_at && Date.parse(updatedAt) < Date.parse(existing.external_updated_at)) {
    return { result: 'unchanged', id: existing.id };
  }
  const statusChanged = existing.status !== newStatus;
  const totalChanged = newTotal !== null && newTotal !== existing.total;
  if (!statusChanged && !totalChanged) return { result: 'unchanged', id: existing.id };
  db.prepare('UPDATE sales SET status = ?, total = COALESCE(?, total), external_updated_at = COALESCE(?, external_updated_at), synced_at = datetime(\'now\') WHERE id = ?')
    .run(newStatus, totalChanged ? newTotal : null, updatedAt || null, existing.id);
  return { result: 'updated', id: existing.id };
}

function importShopifyOrder(order, source, storeId, importedByUserId) {
  // Pending/unpaid orders are imported too - the POS never hides an order
  // because of its payment state.
  const existing = findImported(source.id, order.id);
  if (existing) return refreshExisting(existing, shopifyStatus(order), order.total_price !== undefined ? toCents(order.total_price) : null, order.updated_at);

  const items = order.line_items || [];
  let subtotal = 0, taxTotal = 0;
  const lineItems = items.map((li) => {
    const unitPrice = toCents(li.price);
    const qty = li.quantity || 1;
    const lineTax = (li.tax_lines || []).reduce((s, t) => s + toCents(t.price), 0);
    const lineSubtotal = unitPrice * qty;
    subtotal += lineSubtotal;
    taxTotal += lineTax;
    return {
      product_id: resolveProduct(li.sku, li.title || li.name, unitPrice),
      quantity: qty,
      unit_price: unitPrice,
      tax_rate: lineSubtotal > 0 ? lineTax / lineSubtotal : 0, // a ratio, not a money value — scale-independent
      discount: toCents(li.total_discount),
      line_total: lineSubtotal + lineTax - toCents(li.total_discount),
    };
  });
  const total = order.total_price !== undefined ? toCents(order.total_price) : subtotal + taxTotal;
  const status = shopifyStatus(order);

  const saleResult = db.prepare(`
    INSERT INTO sales (store_id, cashier_id, subtotal, tax_total, discount_total, total, payment_method, status,
      source_type, income_source_id, external_order_id, external_order_number, synced_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'card', ?, 'shopify', ?, ?, ?, datetime('now'), ?)
  `).run(
    storeId, importedByUserId, subtotal, taxTotal, toCents(order.total_discounts), total, status,
    source.id, String(order.id), order.name || `#${order.order_number}`, order.created_at
  );
  const saleId = saleResult.lastInsertRowid;

  const insertItem = db.prepare(`
    INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, tax_rate, discount, line_total)
    VALUES (@sale_id, @product_id, @quantity, @unit_price, @tax_rate, @discount, @line_total)
  `);
  for (const li of lineItems) insertItem.run({ ...li, sale_id: saleId });

  db.prepare(`INSERT INTO payments (sale_id, method, amount, reference) VALUES (?, 'card', ?, ?)`)
    .run(saleId, total, `Shopify order ${order.name || order.id}`);

  const stamp = order.updated_at || (order.date_modified_gmt ? `${order.date_modified_gmt}Z` : order.date_modified) || null;
  if (stamp) db.prepare('UPDATE sales SET external_updated_at = ? WHERE id = ?').run(stamp, saleId);
  linkFulfilmentOrder(source.id, saleId, String(order.id));
  return { result: 'created', id: saleId };
}

function importWooOrder(order, source, storeId, importedByUserId) {
  const existing = findImported(source.id, order.id);
  if (existing) return refreshExisting(existing, wooStatus(order), order.total !== undefined ? toCents(order.total) : null, order.date_modified_gmt ? `${order.date_modified_gmt}Z` : order.date_modified);

  const items = order.line_items || [];
  let subtotal = 0, taxTotal = 0;
  const lineItems = items.map((li) => {
    const lineSubtotal = toCents(li.subtotal || li.total);
    const unitPrice = items.length ? Math.round(lineSubtotal / (li.quantity || 1)) : 0;
    const qty = li.quantity || 1;
    const lineTax = toCents(li.total_tax);
    subtotal += lineSubtotal;
    taxTotal += lineTax;
    return {
      product_id: resolveProduct(li.sku, li.name, unitPrice),
      quantity: qty,
      unit_price: unitPrice,
      tax_rate: lineSubtotal > 0 ? lineTax / lineSubtotal : 0, // a ratio, not a money value — scale-independent
      discount: toCents(li.subtotal) - toCents(li.total),
      line_total: toCents(li.total) + lineTax,
    };
  });
  const total = order.total !== undefined ? toCents(order.total) : subtotal + taxTotal;
  const status = wooStatus(order);

  const saleResult = db.prepare(`
    INSERT INTO sales (store_id, cashier_id, subtotal, tax_total, discount_total, total, payment_method, status,
      source_type, income_source_id, external_order_id, external_order_number, synced_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'card', ?, 'woocommerce', ?, ?, ?, datetime('now'), ?)
  `).run(
    storeId, importedByUserId, subtotal, taxTotal, toCents(order.discount_total), total, status,
    source.id, String(order.id), order.number ? `#${order.number}` : `#${order.id}`, order.date_created
  );
  const saleId = saleResult.lastInsertRowid;

  const insertItem = db.prepare(`
    INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, tax_rate, discount, line_total)
    VALUES (@sale_id, @product_id, @quantity, @unit_price, @tax_rate, @discount, @line_total)
  `);
  for (const li of lineItems) insertItem.run({ ...li, sale_id: saleId });

  db.prepare(`INSERT INTO payments (sale_id, method, amount, reference) VALUES (?, 'card', ?, ?)`)
    .run(saleId, total, order.payment_method_title || `WooCommerce order ${order.id}`);

  const stamp = order.updated_at || (order.date_modified_gmt ? `${order.date_modified_gmt}Z` : order.date_modified) || null;
  if (stamp) db.prepare('UPDATE sales SET external_updated_at = ? WHERE id = ?').run(stamp, saleId);
  linkFulfilmentOrder(source.id, saleId, String(order.id));
  return { result: 'created', id: saleId };
}

// last_sales_synced_at is stored in SQLite's "YYYY-MM-DD HH:MM:SS" form (UTC, a
// space instead of a "T", no zone marker). That is NOT valid ISO8601, and
// WooCommerce's date params are parsed strictly, so convert before sending.
function toIso8601(sqliteDatetime) {
  if (!sqliteDatetime) return null;
  return `${sqliteDatetime.replace(' ', 'T')}Z`;
}

function toSqliteDatetime(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// Re-fetch this much before the last watermark, so an order that was created while
// the previous sync was still downloading is never missed (re-seeing one is
// harmless: it is recognised and skipped/refreshed).
const WATERMARK_OVERLAP_MS = 60 * 1000;

/**
 * options:
 *   storeId  - the signed-in user's store (where imported sales will be visible)
 *   days     - BACKFILL: orders created in the last N days (1-3650)
 *   all      - BACKFILL: everything the platform will give us
 *   (neither) - INCREMENTAL: anything created OR changed since the last sync
 *              (the first ever sync looks back 60 days).
 *
 * Every order is imported on its own, so one malformed order can no longer abort
 * the batch (it used to roll back ALL of them and leave the watermark unmoved, so
 * the same failure repeated forever and history never loaded). Failures are
 * reported, and while any exist the watermark is NOT advanced, so the next sync
 * retries them.
 */
async function syncSales(source, importedByUserId, options = {}) {
  const storeId = ensureOnlineStore(source, options.storeId);
  const movedSales = adoptStraySales(source, storeId);
  if (movedSales > 0) logger.info(`[sales-sync] moved ${movedSales} previously imported sale(s) of "${source.name}" onto store ${storeId} so they appear in Sales History.`);

  const startedAtMs = Date.now();
  const isBackfill = Boolean(options.all || options.days);
  let filters;
  let requestedDays = null;
  if (options.all) {
    filters = { createdSince: '2000-01-01T00:00:00Z' };
    requestedDays = Infinity;
  } else if (options.days) {
    requestedDays = options.days;
    filters = { createdSince: isoDaysAgo(options.days) };
  } else if (source.last_sales_synced_at) {
    filters = { updatedSince: toIso8601(source.last_sales_synced_at) };
  } else {
    filters = { createdSince: isoDaysAgo(FALLBACK_LOOKBACK_DAYS) };
  }

  let orders;
  try {
    orders = source.platform === 'shopify'
      ? await shopify.fetchOrders(source, filters)
      : await woocommerce.fetchOrders(source, filters);
  } catch (err) {
    throw fromUpstreamError(err, source.platform === 'shopify' ? 'Shopify' : 'WooCommerce');
  }

  const importFn = source.platform === 'shopify' ? importShopifyOrder : importWooOrder;
  const importOne = db.transaction((order) => importFn(order, source, storeId, importedByUserId));
  const result = { imported: 0, updated: 0, skipped: 0, failed: 0, total: orders.length, errors: [] };
  for (const order of orders) {
    try {
      const outcome = importOne(order);
      if (outcome.result === 'created') result.imported++;
      else if (outcome.result === 'updated') result.updated++;
      else result.skipped++;
    } catch (err) {
      result.failed++;
      if (result.errors.length < MAX_REPORTED_ERRORS) {
        result.errors.push(`${order.name || order.number || order.id}: ${err.message}`);
      }
      logger.warn(`[sales-sync] could not import ${source.platform} order ${order.id} of "${source.name}": ${err.message}`);
    }
  }

  // Only move the watermark when everything went in; and to when the sync STARTED
  // (minus a margin), not when it finished.
  if (result.failed === 0) {
    db.prepare('UPDATE income_sources SET last_sales_synced_at = ? WHERE id = ?')
      .run(toSqliteDatetime(startedAtMs - WATERMARK_OVERLAP_MS), source.id);
  }

  const dates = orders.map((o) => o.created_at || o.date_created).filter(Boolean).sort();
  result.oldest_order_at = dates[0] || null;
  result.newest_order_at = dates[dates.length - 1] || null;
  result.mode = isBackfill ? (options.all ? 'all' : `last_${options.days}_days`) : 'incremental';

  // Shopify clamps every order query to the last 60 days unless the app holds the
  // read_all_orders scope. If a longer window was asked for and nothing older than
  // that came back, say so - otherwise "it only imported two months" looks like a bug.
  if (
    source.platform === 'shopify' && isBackfill && requestedDays > SHOPIFY_DEFAULT_WINDOW_DAYS && result.total > 0 &&
    !String(source.oauth_scopes || '').includes('read_all_orders') &&
    result.oldest_order_at && Date.parse(result.oldest_order_at) > Date.now() - (SHOPIFY_DEFAULT_WINDOW_DAYS + 3) * 86400000
  ) {
    result.hint = 'Shopify only returned orders from the last 60 days. Older orders need the read_all_orders access scope on your Shopify app (request it under the app\'s Access requests in the Shopify Dev Dashboard / Partner Dashboard), then click Reconnect and sync again.';
  }
  if (source.platform === 'shopify' && isBackfill && requestedDays > SHOPIFY_DEFAULT_WINDOW_DAYS && result.total === 0 && !String(source.oauth_scopes || '').includes('read_all_orders')) {
    result.hint = 'Shopify returned no orders. If the store has orders, check that the app has the read_orders access scope (and read_all_orders for anything older than 60 days), then Reconnect.';
  }
  return result;
}

module.exports = { syncSales, resolveProduct, toIso8601, importShopifyOrder, importWooOrder, findImported, toCents, shopifyStatus };
