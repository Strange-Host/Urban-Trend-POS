const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const incomeSourcesService = require('../services/incomeSources.service');
const shopifyOAuth = require('../services/shopifyOAuth.service');
const shopifyService = require('../services/shopify.service');
const wooProductsService = require('../services/wooProducts.service');
const salesSyncService = require('../services/salesSync.service');
const { fromUpstreamError: asSyncError } = require('../utils/upstreamError');
const liveSync = require('../services/liveSync.service');

const list = asyncHandler(async (req, res) => {
  res.json({ data: incomeSourcesService.list() });
});

const getById = asyncHandler(async (req, res) => {
  res.json({ data: incomeSourcesService.getSafe(req.params.id) });
});

const create = asyncHandler(async (req, res) => {
  // Default the channel to the creator's own store: that is where its sales have
  // to land to be visible in Sales History (see salesSync.ensureOnlineStore).
  res.status(201).json({ data: incomeSourcesService.create({ ...req.body, store_id: req.body.store_id || req.user.storeId }) });
});

const update = asyncHandler(async (req, res) => {
  res.json({ data: incomeSourcesService.update(req.params.id, req.body) });
});

const remove = asyncHandler(async (req, res) => {
  incomeSourcesService.remove(req.params.id);
  res.status(204).send();
});

const testConnection = asyncHandler(async (req, res) => {
  res.json({ data: await incomeSourcesService.testConnection(req.params.id) });
});

// POST /api/income-sources/:id/connect — Shopify only. Exchanges the saved
// shop domain + API key + API secret for an access token via the client
// credentials grant, server-to-server, no browser redirect involved.
const connect = asyncHandler(async (req, res) => {
  const source = incomeSourcesService.getRaw(req.params.id);
  if (source.platform !== 'shopify') {
    throw new ApiError(400, 'Connect is only needed for Shopify — WooCommerce just needs the site URL and consumer key/secret saved.');
  }
  try {
    const updated = await shopifyOAuth.fetchClientCredentialsToken(source);
    res.json({
      data: {
        connected: true,
        scope: updated.oauth_scopes,
        expiresAt: updated.token_expires_at,
      },
    });
  } catch (err) {
    throw asSyncError(err, 'Shopify');
  }
});

// POST /api/income-sources/:id/sync-products
const syncProducts = asyncHandler(async (req, res) => {
  let source = incomeSourcesService.getRaw(req.params.id);
  try {
    if (source.platform === 'shopify') source = await shopifyOAuth.ensureFreshToken(source);
    const result = source.platform === 'shopify'
      ? await shopifyService.pullFromShopify(source, req.user.id)
      : await wooProductsService.pullFromWooCommerce(source, req.user.id);
    res.json({ data: result });
  } catch (err) {
    throw asSyncError(err, source.platform === 'shopify' ? 'Shopify' : 'WooCommerce');
  }
});

// POST /api/income-sources/:id/sync-sales
//   {}              -> everything created or changed since the last sync
//   { days: 365 }   -> backfill: orders created in the last 365 days (1-3650)
//   { all: true }   -> backfill: every order the platform will give us
const syncSales = asyncHandler(async (req, res) => {
  const { days, all } = req.body || {};
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650)) {
    throw new ApiError(400, 'days must be a whole number between 1 and 3650.');
  }
  if (all !== undefined && typeof all !== 'boolean') throw new ApiError(400, 'all must be true or false.');

  let source = incomeSourcesService.getRaw(req.params.id);
  try {
    if (source.platform === 'shopify') source = await shopifyOAuth.ensureFreshToken(source);
    const result = await salesSyncService.syncSales(source, req.user.id, { storeId: req.user.storeId, days, all });
    res.json({ data: result });
  } catch (err) {
    throw asSyncError(err, source.platform === 'shopify' ? 'Shopify' : 'WooCommerce');
  }
});

// GET /api/income-sources/:id/live-sync
const liveSyncStatus = asyncHandler(async (req, res) => {
  res.json({ data: liveSync.status(Number(req.params.id)) });
});

// POST /api/income-sources/:id/live-sync/enable | /disable
const liveSyncEnable = asyncHandler(async (req, res) => {
  try {
    res.json({ data: await liveSync.enable(Number(req.params.id)) });
  } catch (err) {
    throw err.statusCode ? err : asSyncError(err, 'the store');
  }
});
const liveSyncDisable = asyncHandler(async (req, res) => {
  res.json({ data: await liveSync.disable(Number(req.params.id)) });
});

module.exports = { liveSyncStatus, liveSyncEnable, liveSyncDisable, list, getById, create, update, remove, testConnection, connect, syncProducts, syncSales };
