const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { logStaffAction } = require('../utils/auditLog');
const customersService = require('./customers.service');
const settingsService = require('./settings.service');
const incomeSourcesService = require('./incomeSources.service');
const shopifyOAuth = require('./shopifyOAuth.service');
const telesalesDistribution = require('./telesalesDistribution.service');
const salesSync = require('./salesSync.service');
const shopify = require('../config/shopify');
const woocommerce = require('../config/woocommerce');
const { determineDeliveryZone, suggestCourier } = require('../utils/delivery');
const deliveryAreas = require('./deliveryAreas.service');
const { fromUpstreamError } = require('../utils/upstreamError');

// "Pull online orders" on the Orders page.
//
// Sales history already shows every Shopify/WooCommerce order (Sync sales) - but that is a
// REPORTING record: it can't be confirmed, dispatched, handed to a courier, paid against
// or returned. The Orders page runs the shop's fulfilment workflow, so this service turns
// each STILL-TO-SHIP online order into one of those, with its customer, items, payment
// state and a UT code. It is deliberately limited to orders that still need shipping:
// anything already fulfilled or cancelled on the platform is history, not work.
//
// Each online order exists in two places afterwards (sale + order). They are linked
// (orders.sale_id) and the reports count revenue from the sale only - see reports.controller.js.

const DEFAULT_DAYS = 60;
const SHOPIFY_WINDOW_DAYS = 60;
const MAX_REPORTED_ERRORS = 5;

const cents = (v) => Math.round((parseFloat(String(v ?? '0').replace(/,/g, '')) || 0) * 100);
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
const isCodGateway = (text) => /cash on delivery|\bcod\b|pay on delivery|pay at delivery/i.test(text);
const guessMethod = (text) => (/m-?pesa|mobile/i.test(text) ? 'mobile_money' : /bank|transfer|eft/i.test(text) ? 'bank_transfer' : 'card');

// Both platforms reduced to the same shape, so everything after this is platform-agnostic.
function normalizeShopify(o) {
  const ship = o.shipping_address || {};
  const bill = o.billing_address || {};
  const cust = o.customer || {};
  const name = clean(ship.name) || clean(bill.name) || [cust.first_name, cust.last_name].map(clean).filter(Boolean).join(' ');
  const gateways = (o.payment_gateway_names || []).join(' ');
  const lines = (o.line_items || []).map((li) => ({
    sku: clean(li.sku) || null, title: clean(li.title) || 'Online item', quantity: Math.max(parseInt(li.quantity, 10) || 1, 1),
    unitPrice: cents(li.price), discount: cents(li.total_discount),
  }));
  return {
    externalId: String(o.id), label: o.name || `#${o.order_number || o.id}`, createdAt: o.created_at,
    cancelled: Boolean(o.cancelled_at),
    toShip: !o.cancelled_at && [null, undefined, 'partial', 'unfulfilled'].includes(o.fulfillment_status),
    paid: o.financial_status === 'paid',
    cod: isCodGateway(gateways) || (o.financial_status !== 'paid' && o.financial_status !== 'partially_paid'),
    gateway: gateways,
    customer: {
      name: name || 'Online customer',
      phone: clean(ship.phone) || clean(bill.phone) || clean(cust.phone) || clean(o.phone),
      email: clean(o.email) || clean(cust.email) || null,
      city: clean(ship.city) || clean(ship.province) || clean(bill.city) || null,
    },
    lines, note: o.note || null,
  };
}

function normalizeWoo(o) {
  const bill = o.billing || {};
  const ship = o.shipping || {};
  const name = [ship.first_name || bill.first_name, ship.last_name || bill.last_name].map(clean).filter(Boolean).join(' ');
  const gateway = `${clean(o.payment_method)} ${clean(o.payment_method_title)}`;
  const lines = (o.line_items || []).map((li) => {
    const qty = Math.max(parseInt(li.quantity, 10) || 1, 1);
    const gross = cents(li.subtotal);                 // before discount
    return { sku: clean(li.sku) || null, title: clean(li.name) || 'Online item', quantity: qty,
      unitPrice: Math.round(gross / qty), discount: Math.max(gross - cents(li.total), 0) };
  });
  return {
    externalId: String(o.id), label: `#${o.number || o.id}`, createdAt: o.date_created_gmt ? `${o.date_created_gmt}Z` : o.date_created,
    cancelled: ['cancelled', 'refunded', 'failed', 'trash'].includes(o.status),
    toShip: ['pending', 'processing', 'on-hold'].includes(o.status),
    paid: Boolean(o.date_paid) && o.payment_method !== 'cod',
    cod: o.payment_method === 'cod' || !o.date_paid,
    gateway,
    customer: { name: name || 'Online customer', phone: clean(bill.phone) || clean(ship.phone), email: clean(bill.email) || null, city: clean(ship.city) || clean(bill.city) || null },
    lines, note: o.customer_note || null,
  };
}

function platformInfo(source) {
  return source.platform === 'shopify'
    ? { channel: 'shopify', normalize: normalizeShopify, importSale: salesSync.importShopifyOrder, label: 'Shopify' }
    : { channel: 'wordpress', normalize: normalizeWoo, importSale: salesSync.importWooOrder, label: 'WooCommerce' };
}

// Creates the fulfilment order (and, if Sales history doesn't have it yet, the sale), all or nothing.
function createFulfilmentOrder({ source, info, raw, norm, storeId, userId }) {
  if (!norm.customer.phone) throw new Error('the order has no phone number - Shopify/WooCommerce checkout must collect one for the shop to deliver');
  if (norm.lines.length === 0) throw new Error('the order has no items');

  const customer = customersService.findOrCreate({ name: norm.customer.name, phone: norm.customer.phone, email: norm.customer.email, city: norm.customer.city });

  let subtotal = 0; let discount = 0;
  const items = norm.lines.map((l) => {
    const gross = l.unitPrice * l.quantity;
    const disc = Math.min(l.discount, gross);
    subtotal += gross; discount += disc;
    return { product_id: salesSync.resolveProduct(l.sku, l.title, l.unitPrice), quantity: l.quantity, unit_price: l.unitPrice, discount: disc, line_total: gross - disc };
  });
  const total = subtotal - discount;

  const settings = settingsService.getAll();
  const zone = determineDeliveryZone(customer.city);
  const { fee, area } = deliveryAreas.resolveFee({ town: customer.city, totalCents: total, settings });
  const paymentType = norm.paid ? 'prepaid' : 'cod';
  const windowMinutes = parseInt(settings.cod_confirmation_window_minutes, 10) || 120;
  const expires = paymentType === 'cod' ? db.prepare(`SELECT datetime('now', '+' || ? || ' minutes') AS v`).get(windowMinutes).v : null;

  const inserted = db.prepare(`
    INSERT INTO orders (store_id, customer_id, assigned_staff_id, channel, external_order_id, income_source_id, subtotal, discount_total, total,
      amount_paid, notes, payment_type, courier_type, delivery_zone, delivery_fee, cod_confirmation_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(storeId, customer.id, telesalesDistribution.autoAssignOrder(storeId) || null, info.channel, norm.externalId, source.id, subtotal, discount, total,
    norm.paid ? total : 0, `Imported from ${info.label} order ${norm.label}${norm.note ? ` - customer note: ${norm.note}` : ''}`,
    paymentType, area?.courier_type || suggestCourier(zone), zone, fee, expires);
  const orderId = inserted.lastInsertRowid;

  db.prepare('UPDATE orders SET product_code = ? WHERE id = ?').run(`UT${String(orderId).padStart(6, '0')}`, orderId);
  const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price, discount, line_total) VALUES (@order_id, @product_id, @quantity, @unit_price, @discount, @line_total)');
  for (const it of items) insertItem.run({ ...it, order_id: orderId });
  db.prepare('INSERT INTO order_status_history (order_id, from_status, to_status, notes, changed_by_staff_id) VALUES (?, NULL, \'awaiting_dispatch\', ?, ?)')
    .run(orderId, `Imported from ${info.label} (${norm.label})`, userId);

  // Already paid online: record that payment so the order's history is complete and a later
  // refund/dispute has something to refer to. Dispatch then lands it straight in "paid".
  if (norm.paid && total > 0) {
    db.prepare(`INSERT INTO payment_records (store_id, direction, order_id, method, amount, reference, recorded_by_staff_id)
      VALUES (?, 'incoming', ?, ?, ?, ?, ?)`).run(storeId, orderId, guessMethod(norm.gateway), total, `${info.channel}:${norm.label}`, userId);
  }

  // Link to (or create) the Sales-history record of the same order.
  const existingSale = salesSync.findImported(source.id, norm.externalId);
  let saleId = existingSale ? existingSale.id : null;
  if (!saleId) {
    const made = info.importSale(raw, source, storeId, userId);
    saleId = made.id;
  }
  db.prepare('UPDATE orders SET sale_id = ? WHERE id = ?').run(saleId, orderId);

  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  logStaffAction({ staffId: userId, action: 'create', entityType: 'order', entityId: orderId, after: row });
  return row;
}

function cancelIfStillWaiting(existing, userId, label) {
  if (existing.status !== 'awaiting_dispatch') return false;
  db.prepare(`UPDATE orders SET status = 'cancelled', cancelled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(existing.id);
  db.prepare(`INSERT INTO order_status_history (order_id, from_status, to_status, notes, changed_by_staff_id)
    VALUES (?, 'awaiting_dispatch', 'cancelled', ?, ?)`).run(existing.id, `Cancelled on the online store (${label}) before dispatch.`, userId);
  return true;
}

/**
 * options: { storeId, userId, days }  (days: how far back to look, default 60)
 * Returns counts plus a plain-language hint when Shopify's 60-day window is the reason for a short result.
 */
async function pullOrders({ incomeSourceId, storeId, userId, days }) {
  const lookback = days || DEFAULT_DAYS;
  let source = incomeSourcesService.getRaw(incomeSourceId);
  if (!source.is_active) throw new ApiError(409, 'That connection is switched off.');
  const info = platformInfo(source);

  let raws;
  try {
    if (source.platform === 'shopify') source = await shopifyOAuth.ensureFreshToken(source);
    const createdSince = new Date(Date.now() - lookback * 86400000).toISOString();
    raws = source.platform === 'shopify'
      ? await shopify.fetchOrders(source, { createdSince })
      : await woocommerce.fetchOrders(source, { createdSince });
  } catch (err) {
    throw fromUpstreamError(err, info.label);
  }

  const result = { found: raws.length, imported: 0, cancelled: 0, skipped: 0, ignored: 0, failed: 0, errors: [], days: lookback };
  const findExisting = db.prepare('SELECT id, status FROM orders WHERE income_source_id = ? AND external_order_id = ? AND deleted_at IS NULL');

  for (const raw of raws) {
    const norm = info.normalize(raw);
    try {
      const existing = findExisting.get(source.id, norm.externalId);
      if (existing) {
        if (norm.cancelled && cancelIfStillWaiting(existing, userId, norm.label)) result.cancelled++;
        else result.skipped++;
        continue;
      }
      if (!norm.toShip) { result.ignored++; continue; }   // already shipped / cancelled / completed on the store
      db.transaction(() => createFulfilmentOrder({ source, info, raw, norm, storeId, userId }))();
      result.imported++;
    } catch (err) {
      result.failed++;
      if (result.errors.length < MAX_REPORTED_ERRORS) result.errors.push(`${norm.label}: ${err.message}`);
      logger.warn(`[online-orders] could not import ${info.label} order ${norm.externalId}: ${err.message}`);
    }
  }

  if (source.platform === 'shopify' && lookback > SHOPIFY_WINDOW_DAYS && !String(source.oauth_scopes || '').includes('read_all_orders')) {
    result.hint = 'Shopify only shows an app the last 60 days of orders (older ones need the read_all_orders access scope). Orders still waiting to ship are normally recent, so this is rarely a problem here.';
  }
  return result;
}

// What the Orders page needs to decide whether to show the button: only the safe fields.
function listConnections() {
  return incomeSourcesService.list()
    .filter((s) => s.platform === 'shopify' ? s.has_access_token : s.has_consumer_key)
    .map((s) => ({ id: s.id, name: s.name, platform: s.platform }));
}

module.exports = { pullOrders, listConnections, normalizeShopify, normalizeWoo, platformInfo, createFulfilmentOrder, cancelIfStillWaiting };
