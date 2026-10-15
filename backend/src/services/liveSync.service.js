const crypto = require('crypto');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { encrypt } = require('../utils/crypto');
const incomeSourcesService = require('./incomeSources.service');
const systemConfig = require('./systemConfig.service');
const settingsService = require('./settings.service');
const notificationsService = require('./notifications.service');
const salesSync = require('./salesSync.service');
const onlineOrders = require('./onlineOrders.service');
const productSync = require('./productSync.service');
const shopifyService = require('./shopify.service');
const wooProductsService = require('./wooProducts.service');
const shopifyOAuth = require('./shopifyOAuth.service');
const shopify = require('../config/shopify');
const woocommerce = require('../config/woocommerce');
const { getOrCreateSystemUser } = require('./paymentReconciliation.service');

// LIVE SYNC - a change in Shopify or WooCommerce reaches the POS within seconds.
//
// 1. WEBHOOKS (the fast path). We ask the store to call us the moment an order or product changes.
//    Every delivery is checked against the store's own signature (HMAC-SHA256 of the raw body), so
//    nobody who merely knows the address can feed us fake orders.
// 2. A SAFETY-NET POLL (the reliable path). Webhooks can be missed - the server was off, the tunnel
//    changed, the store gave up after repeated failures - so every few minutes we also ask each
//    store "what changed since I last looked?". That is also what makes a store with webhooks
//    switched off still stay reasonably current.
// Both go through the same import code as the manual buttons, so behaviour is identical.

const SHOPIFY_TOPICS = ['orders/create', 'orders/updated', 'orders/cancelled', 'products/create', 'products/update', 'products/delete'];
const WOO_TOPICS = ['order.created', 'order.updated', 'order.deleted', 'product.created', 'product.updated', 'product.deleted'];
const topicsFor = (platform) => (platform === 'shopify' ? SHOPIFY_TOPICS : WOO_TOPICS);

const pathFor = (source) => `/api/integrations/webhooks/${source.platform === 'shopify' ? 'shopify' : 'woocommerce'}/${source.id}`;

function addressFor(source) {
  const base = systemConfig.publicBaseUrl();
  if (!base) throw new ApiError(400, 'Your public web address is not set. Enter it under Settings > Server & public address first - the store needs it to know where to send changes.');
  if (!/^https:\/\//i.test(base)) throw new ApiError(400, 'The public web address must start with https:// - Shopify and WooCommerce only send changes to secure addresses.');
  return `${base}${pathFor(source)}`;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const hmacBase64 = (secret, raw) => crypto.createHmac('sha256', secret).update(raw).digest('base64');

function storeIdFor(source) {
  if (source.store_id) return source.store_id;
  const first = db.prepare('SELECT id FROM stores WHERE is_active = 1 ORDER BY id LIMIT 1').get();
  if (!first) throw new Error('No store is configured.');
  return first.id;
}

function logEvent(sourceId, topic, deliveryId, status, detail) {
  try {
    db.prepare('INSERT INTO webhook_events (income_source_id, topic, delivery_id, status, detail) VALUES (?, ?, ?, ?, ?)')
      .run(sourceId, topic, deliveryId || null, status, detail ? String(detail).slice(0, 300) : null);
  } catch (err) {
    if (!String(err.message).includes('UNIQUE')) logger.warn(`[live-sync] could not log an event: ${err.message}`);
  }
}

// ------------------------------------------------------------------ switching it on / off

async function enableShopify(source, address) {
  if (!source.api_secret) {
    throw new ApiError(400, 'Live sync needs this connection\'s Client secret (Shopify signs every message with it). Edit the connection, add the Client secret, and try again.');
  }
  const fresh = await shopifyOAuth.ensureFreshToken(source);
  const existing = await shopify.listWebhooks(fresh);
  const mine = `/api/integrations/webhooks/shopify/${source.id}`;
  const results = [];
  for (const topic of SHOPIFY_TOPICS) {
    try {
      const found = existing.find((w) => w.topic === topic && String(w.address).includes(mine));
      let hook = found;
      if (!found) hook = await shopify.createWebhook(fresh, topic, address);
      else if (found.address !== address) hook = await shopify.updateWebhookAddress(fresh, found.id, address);
      results.push({ topic, ok: true, remote_id: String(hook.id) });
    } catch (err) {
      // 422 "address ... has already been taken" = it is already there; fine.
      const already = err.response?.status === 422 && /already been taken/i.test(JSON.stringify(err.response.data || ''));
      if (already) results.push({ topic, ok: true, remote_id: null });
      else results.push({ topic, ok: false, error: describeStoreError(err, topic) });
    }
  }
  return results;
}

function describeStoreError(err, topic) {
  const status = err.response?.status;
  const body = JSON.stringify(err.response?.data || '').slice(0, 200);
  if (status === 401 || status === 403) {
    return /order/.test(topic)
      ? 'The store refused access - the app needs the read_orders permission (Shopify) or a key with Read/Write access (WooCommerce).'
      : 'The store refused access - the app needs the read_products permission (Shopify) or a key with Read/Write access (WooCommerce).';
  }
  if (status === 404) return 'The store does not offer this webhook (is the address and API version right?).';
  return `${status ? `HTTP ${status}: ` : ''}${body || err.message}`;
}

async function enableWoo(source, address) {
  let secret = source.webhook_secret;
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE income_sources SET webhook_secret = ? WHERE id = ?').run(encrypt(secret), source.id);
  }
  const results = [];
  let existing = [];
  try { existing = await woocommerce.listWebhooks(source); } catch { /* a read-only key can still list; if not we find out on create */ }
  for (const topic of WOO_TOPICS) {
    try {
      const found = existing.find((w) => w.topic === topic && w.delivery_url === address);
      const hook = found || await woocommerce.createWebhook(source, { name: `Urban Trends POS - ${topic}`, topic, deliveryUrl: address, secret });
      results.push({ topic, ok: true, remote_id: String(hook.id) });
    } catch (err) {
      results.push({ topic, ok: false, error: describeStoreError(err, topic), readOnly: [401, 403].includes(err.response?.status) });
    }
  }
  return { results, secret };
}

async function enable(sourceId) {
  const source = incomeSourcesService.getRaw(sourceId);
  if (!source.is_active) throw new ApiError(409, 'That connection is switched off.');
  const address = addressFor(source);

  let results; let secret = null;
  if (source.platform === 'shopify') {
    results = await enableShopify(source, address);
  } else {
    ({ results, secret } = await enableWoo(source, address));
  }

  const ok = results.filter((r) => r.ok);
  const save = db.prepare('INSERT INTO income_source_webhooks (income_source_id, topic, remote_id, address) VALUES (?, ?, ?, ?) ON CONFLICT(income_source_id, topic) DO UPDATE SET remote_id = excluded.remote_id, address = excluded.address');
  db.transaction(() => { for (const r of ok) save.run(source.id, r.topic, r.remote_id, address); })();
  db.prepare('UPDATE income_sources SET live_sync_enabled = ? WHERE id = ?').run(ok.length > 0 ? 1 : 0, source.id);

  const allReadOnly = source.platform === 'woocommerce' && results.every((r) => r.readOnly);
  return {
    enabled: ok.length > 0, address, results,
    // A read-only WooCommerce key cannot create webhooks. Everything needed to add them by hand:
    manual: allReadOnly ? manualInstructions(source, address, secret) : null,
    message: ok.length === results.length ? 'Live sync is on - changes will arrive within seconds.'
      : ok.length > 0 ? `Live sync is partly on (${ok.length} of ${results.length} change types). See the details below.`
      : (allReadOnly ? 'This WooCommerce key is read-only, so webhooks could not be created automatically. Add them by hand using the details below, or replace the key with a Read/Write one.' : 'Live sync could not be turned on. See the details below.'),
  };
}

function manualInstructions(source, address, secretOverride) {
  const fresh = incomeSourcesService.getRaw(source.id);
  return { delivery_url: address, secret: secretOverride || fresh.webhook_secret || null, topics: WOO_TOPICS };
}

async function disable(sourceId) {
  const source = incomeSourcesService.getRaw(sourceId);
  const rows = db.prepare('SELECT * FROM income_source_webhooks WHERE income_source_id = ?').all(sourceId);
  const problems = [];
  try {
    const live = source.platform === 'shopify' ? await shopifyOAuth.ensureFreshToken(source) : source;
    for (const row of rows) {
      if (!row.remote_id) continue;
      try {
        if (source.platform === 'shopify') await shopify.deleteWebhook(live, row.remote_id); else await woocommerce.deleteWebhook(live, row.remote_id);
      } catch (err) {
        if (err.response?.status !== 404) problems.push(`${row.topic}: ${describeStoreError(err, row.topic)}`);
      }
    }
  } catch (err) {
    problems.push(err.message);
  }
  db.prepare('DELETE FROM income_source_webhooks WHERE income_source_id = ?').run(sourceId);
  db.prepare('UPDATE income_sources SET live_sync_enabled = 0 WHERE id = ?').run(sourceId);
  return { enabled: false, problems };
}

function status(sourceId) {
  const source = incomeSourcesService.getRaw(sourceId);
  const registered = new Set(db.prepare('SELECT topic FROM income_source_webhooks WHERE income_source_id = ?').all(sourceId).map((r) => r.topic));
  const counts = Object.fromEntries(db.prepare(`
    SELECT status, COUNT(*) n FROM webhook_events WHERE income_source_id = ? AND received_at >= datetime('now', '-1 day') GROUP BY status
  `).all(sourceId).map((r) => [r.status, r.n]));
  let address = null;
  try { address = addressFor(source); } catch { /* public address not set yet - shown as a to-do in the UI */ }
  return {
    enabled: source.live_sync_enabled === 1,
    public_address_ready: Boolean(address),
    topics: topicsFor(source.platform).map((t) => ({ topic: t, registered: registered.has(t) })),
    last_webhook_at: source.last_webhook_at || null,
    last_poll_at: source.last_poll_at || null,
    last_poll_error: source.last_poll_error || null,
    events_24h: { processed: counts.processed || 0, ignored: counts.ignored || 0, failed: counts.failed || 0, duplicate: counts.duplicate || 0 },
    recent_failures: db.prepare("SELECT topic, detail, received_at FROM webhook_events WHERE income_source_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 5").all(sourceId),
    manual: source.platform === 'woocommerce' && address ? manualInstructions(source, address) : null,
  };
}

// ---------------------------------------------------------------------- receiving

/**
 * Returns { httpStatus, body }. 401 only for a bad signature/shop (so the store retries nothing that
 * can never succeed); once the message is AUTHENTIC we always answer 200 - even if importing it hit a
 * data problem - because a non-2xx makes stores retry for days and then delete the subscription,
 * which would silently end live sync. Failures are recorded and shown in Settings instead.
 */
async function receive({ platform, sourceId, headers, rawBody, body }) {
  let source;
  try { source = incomeSourcesService.getRaw(sourceId); } catch { return { httpStatus: 404, body: { error: 'Unknown connection.' } }; }
  if (source.platform !== platform) return { httpStatus: 404, body: { error: 'Unknown connection.' } };

  // WooCommerce sends an unsigned form-encoded "ping" when a webhook is created; it only wants a 200.
  if (platform === 'woocommerce' && !headers['x-wc-webhook-signature'] && body && typeof body === 'object' && body.webhook_id && !body.id) {
    return { httpStatus: 200, body: { status: 'pong' } };
  }

  let topic; let deliveryId;
  if (platform === 'shopify') {
    topic = headers['x-shopify-topic'];
    deliveryId = headers['x-shopify-webhook-id'] || headers['x-shopify-event-id'];
    const shop = String(headers['x-shopify-shop-domain'] || '').toLowerCase();
    if (!source.api_secret || !safeEqual(hmacBase64(source.api_secret, rawBody || Buffer.alloc(0)), headers['x-shopify-hmac-sha256'])
        || (source.shop_domain && shop && shop !== String(source.shop_domain).toLowerCase())) {
      return { httpStatus: 401, body: { error: 'Invalid signature.' } };
    }
  } else {
    topic = headers['x-wc-webhook-topic'];
    deliveryId = headers['x-wc-webhook-delivery-id'] || headers['x-wc-webhook-id'];
    if (!source.webhook_secret || !safeEqual(hmacBase64(source.webhook_secret, rawBody || Buffer.alloc(0)), headers['x-wc-webhook-signature'])) {
      return { httpStatus: 401, body: { error: 'Invalid signature.' } };
    }
  }
  if (!topic) return { httpStatus: 200, body: { status: 'ignored', reason: 'no topic' } };

  if (!source.is_active || source.live_sync_enabled !== 1) {
    return { httpStatus: 200, body: { status: 'ignored', reason: 'live sync is off for this connection' } };
  }
  if (deliveryId && db.prepare("SELECT 1 FROM webhook_events WHERE income_source_id = ? AND delivery_id = ? AND status IN ('processed','ignored')").get(sourceId, String(deliveryId))) {
    logEvent(sourceId, topic, null, 'duplicate', 'Already handled (the store re-sent it).');
    return { httpStatus: 200, body: { status: 'duplicate' } };
  }

  db.prepare("UPDATE income_sources SET last_webhook_at = datetime('now') WHERE id = ?").run(sourceId);
  try {
    const outcome = await dispatch(source, topic, body || {});
    logEvent(sourceId, topic, deliveryId && String(deliveryId), outcome.status, outcome.detail);
    return { httpStatus: 200, body: { status: outcome.status } };
  } catch (err) {
    logger.warn(`[live-sync] ${source.platform} "${topic}" for "${source.name}" failed: ${err.message}`);
    logEvent(sourceId, topic, null, 'failed', err.message);
    return { httpStatus: 200, body: { status: 'failed' } };
  }
}

async function dispatch(source, topic, payload) {
  const [resource, action] = source.platform === 'shopify' ? topic.split('/') : topic.split('.');
  if (resource === 'orders' || resource === 'order') return handleOrder(source, payload, action);
  if (resource === 'products' || resource === 'product') return handleProduct(source, payload, action);
  return { status: 'ignored', detail: `Not a topic we use: ${topic}` };
}

function handleOrder(source, raw, action) {
  const info = onlineOrders.platformInfo(source);
  const label = info.label;
  const storeId = storeIdFor(source);
  const system = getOrCreateSystemUser(storeId);
  const settings = settingsService.getAll();

  // A WooCommerce "deleted" delivery carries only the id. Treat it as a cancellation.
  const deleted = action === 'deleted';
  const payload = deleted ? { ...raw, status: 'cancelled' } : raw;
  const norm = info.normalize(payload);
  if (!norm.externalId || norm.externalId === 'undefined') return { status: 'ignored', detail: 'The delivery had no order id.' };

  return db.transaction(() => {
    const existingSale = salesSync.findImported(source.id, norm.externalId);
    let sale;
    if (deleted && !existingSale) return { status: 'ignored', detail: 'Deleted order we never imported.' };
    if (deleted) {
      db.prepare("UPDATE sales SET status = 'voided', synced_at = datetime('now') WHERE id = ?").run(existingSale.id);
      sale = { result: 'updated', id: existingSale.id };
    } else {
      sale = info.importSale(payload, source, storeId, system.id);
    }

    const existingOrder = db.prepare('SELECT id, status FROM orders WHERE income_source_id = ? AND external_order_id = ? AND deleted_at IS NULL').get(source.id, norm.externalId);
    let createdOrder = null;
    let cancelled = false;
    if (existingOrder) {
      if (norm.cancelled) cancelled = onlineOrders.cancelIfStillWaiting(existingOrder, system.id, norm.label);
    } else if (settings.online_auto_import_orders === '1' && norm.toShip && norm.customer.phone && norm.lines.length > 0) {
      createdOrder = onlineOrders.createFulfilmentOrder({ source, info, raw: payload, norm, storeId, userId: system.id });
    }

    const isNew = sale.result === 'created';
    if (isNew || createdOrder) {
      const kes = (norm.lines.reduce((n, l) => n + l.unitPrice * l.quantity - l.discount, 0) / 100).toLocaleString('en-KE');
      notificationsService.notify({
        storeId, roles: ['admin', 'manager'], userIds: createdOrder?.assigned_staff_id ? [createdOrder.assigned_staff_id] : [],
        type: 'online_order', severity: 'info',
        title: `New ${label} order ${norm.label}`, body: `${norm.customer.name} · KES ${kes}${createdOrder ? ' · added to Orders' : ''}`,
        entityType: createdOrder ? 'order' : 'sale', entityId: createdOrder ? createdOrder.id : sale.id,
        dedupeKey: `online_order:${source.id}:${norm.externalId}`,
      });
    } else if (cancelled) {
      notificationsService.notify({
        storeId, roles: ['admin', 'manager'], type: 'online_order', severity: 'warning',
        title: `${label} order ${norm.label} was cancelled`, body: 'It had not been dispatched, so it was cancelled here too.',
        entityType: 'order', entityId: existingOrder.id, dedupeKey: `online_order_cancel:${source.id}:${norm.externalId}`,
      });
    }

    const parts = [`sale ${sale.result}`];
    if (createdOrder) parts.push('order created');
    if (cancelled) parts.push('waiting order cancelled');
    return { status: sale.result === 'unchanged' && !createdOrder && !cancelled ? 'ignored' : 'processed', detail: `${norm.label}: ${parts.join(', ')}` };
  })();
}

async function handleProduct(source, raw, action) {
  const label = source.platform === 'shopify' ? 'Shopify' : 'WooCommerce';
  const storeId = storeIdFor(source);
  if (action === 'delete' || action === 'deleted') {
    const gone = db.prepare('SELECT name FROM shopify_staging_products WHERE income_source_id = ? AND shopify_product_id = ?').all(source.id, String(raw.id));
    const names = [...new Set(gone.map((g) => g.name))];
    if (names.length) {
      notificationsService.notify({
        storeId, roles: ['admin', 'manager'], type: 'online_product', severity: 'warning',
        title: `Product removed on ${label}: ${names[0]}${names.length > 1 ? ` +${names.length - 1} more` : ''}`,
        body: 'It is still active in your POS - deactivate it under Catalog if you no longer sell it.',
        entityType: 'product', entityId: null, dedupeKey: `online_product_delete:${source.id}:${raw.id}`,
      });
    }
    return { status: names.length ? 'processed' : 'ignored', detail: `Product ${raw.id} deleted${names.length ? '' : ' (never imported)'}` };
  }
  // The ingest counts any product that is not yet in the live catalogue as "new" every time it sees it,
  // so judge "did anything actually change?" by comparing what is staged before and after.
  const snapshot = () => JSON.stringify(db.prepare(
    'SELECT shopify_variant_id, name, sell_price, inventory_qty, raw_json FROM shopify_staging_products WHERE income_source_id = ? AND shopify_product_id = ? ORDER BY shopify_variant_id',
  ).all(source.id, String(raw.id)));
  const before = snapshot();
  const result = source.platform === 'shopify'
    ? shopifyService.ingestShopifyProducts(source, [raw], null)
    : await wooProductsService.ingestWooProducts(source, [raw], null);
  const changed = before !== snapshot();
  if (changed) {
    notificationsService.notify({
      storeId, roles: ['admin', 'manager'], type: 'online_product', severity: 'info',
      title: `${label} product ${before === '[]' ? 'added' : 'changed'}: ${raw.title || raw.name || raw.id}`,
      body: 'Review it on the Shopify sync page.', entityType: 'product', entityId: null,
      dedupeKey: `online_product:${source.id}:${raw.id}:${raw.updated_at || raw.date_modified_gmt || Date.now()}`,
    });
  }
  return { status: changed ? 'processed' : 'ignored', detail: `${raw.title || raw.name || raw.id}: ${changed ? `${result.created} new, ${result.updated} changed` : 'nothing changed'}` };
}

// ------------------------------------------------------------------ the safety-net poll

let polling = false;
let lastProductPollAt = new Map();
const PRODUCT_POLL_MS = 60 * 60 * 1000;

/** Called every minute by server.js. Does real work only for stores whose own interval has elapsed. */
async function pollTick({ now = Date.now() } = {}) {
  if (polling) return { skipped: true };
  const minutes = parseInt(settingsService.getAll().live_poll_minutes, 10);
  if (!minutes || minutes < 1) return { skipped: true, reason: 'off' };
  polling = true;
  const done = [];
  const stamp = new Date(now).toISOString().slice(0, 19).replace('T', ' ');   // the same clock the interval is judged on
  try {
    for (const c of productSync.connections()) {
      const row = incomeSourcesService.getRaw(c.id);
      const last = row.last_poll_at ? Date.parse(`${row.last_poll_at.replace(' ', 'T')}Z`) : 0;
      if (now - last < minutes * 60 * 1000 - 5000) continue;

      const storeId = storeIdFor(row);
      const system = getOrCreateSystemUser(storeId);
      try {
        let source = row;
        if (source.platform === 'shopify') source = await shopifyOAuth.ensureFreshToken(source);
        // 1) orders created OR changed since last time -> Sales history (this also applies cancellations/refunds)
        await salesSync.syncSales(source, system.id, { storeId });
        // 2) to-ship orders -> the Orders page (only if the shop wants them added automatically)
        if (settingsService.getAll().online_auto_import_orders === '1') {
          await onlineOrders.pullOrders({ incomeSourceId: source.id, storeId, userId: system.id, days: 7 });
        }
        // 3) the catalogue, hourly (a full product download is the heaviest call, so it is rationed)
        if (now - (lastProductPollAt.get(c.id) || 0) > PRODUCT_POLL_MS) {
          await productSync.pullOne(source.id, system.id);
          lastProductPollAt.set(c.id, now);
        }
        db.prepare('UPDATE income_sources SET last_poll_at = ?, last_poll_error = NULL WHERE id = ?').run(stamp, c.id);
        done.push({ id: c.id, ok: true });
      } catch (err) {
        logger.warn(`[live-sync] poll of "${row.name}" failed: ${err.message}`);
        db.prepare('UPDATE income_sources SET last_poll_at = ?, last_poll_error = ? WHERE id = ?').run(stamp, String(err.message).slice(0, 300), c.id);
        done.push({ id: c.id, ok: false, error: err.message });
      }
    }
    // keep the log from growing forever
    db.prepare("DELETE FROM webhook_events WHERE received_at < datetime('now', '-30 days')").run();
    return { polled: done };
  } finally {
    polling = false;
  }
}

function resetPollState() { polling = false; lastProductPollAt = new Map(); }

module.exports = { enable, disable, status, receive, pollTick, resetPollState, SHOPIFY_TOPICS, WOO_TOPICS, hmacBase64 };
