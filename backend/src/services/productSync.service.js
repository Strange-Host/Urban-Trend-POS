const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const incomeSourcesService = require('./incomeSources.service');
const shopifyService = require('./shopify.service');
const wooProductsService = require('./wooProducts.service');
const shopifyOAuth = require('./shopifyOAuth.service');
const { fromUpstreamError } = require('../utils/upstreamError');

// "Pull products" for the Shopify sync page. The button there used to call the OLD single-shop
// route, which reads SHOPIFY_SHOP / SHOPIFY_ACCESS_TOKEN from a server file and fails with
// "not set" for anyone who connected their store the normal way (Settings -> Income sources).
// This pulls from those connections instead - one store, or all of them.

function connections() {
  return incomeSourcesService.list()
    .filter((s) => s.is_active && (s.platform === 'shopify' ? s.has_access_token : s.has_consumer_key))
    .map((s) => ({
      id: s.id, name: s.name, platform: s.platform, live_sync_enabled: s.live_sync_enabled === 1,
      last_synced_at: s.last_synced_at || null,
      pending: db.prepare("SELECT COUNT(*) n FROM shopify_staging_products WHERE income_source_id = ? AND review_status = 'pending'").get(s.id).n,
    }));
}

async function pullOne(sourceId, userId) {
  let source = incomeSourcesService.getRaw(sourceId);
  if (!source.is_active) throw new ApiError(409, 'That connection is switched off.');
  const label = source.platform === 'shopify' ? 'Shopify' : 'WooCommerce';
  try {
    if (source.platform === 'shopify') source = await shopifyOAuth.ensureFreshToken(source);
    const result = source.platform === 'shopify'
      ? await shopifyService.pullFromShopify(source, userId)
      : await wooProductsService.pullFromWooCommerce(source, userId);
    db.prepare("UPDATE income_sources SET last_synced_at = datetime('now') WHERE id = ?").run(sourceId);
    return result;
  } catch (err) {
    throw fromUpstreamError(err, label);
  }
}

/**
 * incomeSourceId given -> that store (errors propagate).
 * omitted             -> every connected store; one store failing does not stop the others.
 * Always returns the summed counts plus a per-store breakdown.
 */
async function pullProducts({ incomeSourceId, userId }) {
  const targets = incomeSourceId ? [{ id: incomeSourceId }] : connections();
  if (targets.length === 0) {
    // Nothing connected the new way: fall back to the old single-shop settings if (and only if) they exist.
    try {
      const legacy = shopifyService.getLegacyEnvSource();
      const r = await shopifyService.pullFromShopify(legacy, userId);
      return { ...r, results: [{ name: 'Shopify (legacy settings)', platform: 'shopify', ok: true, ...r }] };
    } catch {
      throw new ApiError(400, 'No Shopify or WooCommerce store is connected yet. Add one under Settings > Income sources, press Connect, then try again.');
    }
  }

  const total = { created: 0, updated: 0, unchanged: 0, total: 0, results: [] };
  for (const t of targets) {
    const info = incomeSourcesService.getRaw(t.id);
    try {
      const r = await pullOne(t.id, userId);
      for (const k of ['created', 'updated', 'unchanged', 'total']) total[k] += r[k] || 0;
      total.results.push({ id: t.id, name: info.name, platform: info.platform, ok: true, ...r });
    } catch (err) {
      if (incomeSourceId) throw err;
      total.results.push({ id: t.id, name: info.name, platform: info.platform, ok: false, error: err.message });
    }
  }
  return total;
}

module.exports = { connections, pullProducts, pullOne };
