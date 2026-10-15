const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const shopifyService = require('../services/shopify.service');
const productSync = require('../services/productSync.service');

// GET /api/integrations/shopify/connections - the stores the sync page can pull from
const connections = asyncHandler(async (req, res) => {
  res.json({ data: productSync.connections() });
});

// POST /api/integrations/shopify/sync  { income_source_id? } - pull the catalog into staging.
// Pulls from the stores connected under Settings > Income sources (one if you name it, otherwise
// all of them). It used to read a separate single-shop setting that nobody fills in any more.
const sync = asyncHandler(async (req, res) => {
  const id = req.body?.income_source_id;
  if (id !== undefined && (!Number.isInteger(id) || id < 1)) throw new ApiError(400, 'income_source_id must be a store id.');
  res.json({ data: await productSync.pullProducts({ incomeSourceId: id, userId: req.user.id }) });
});

// GET /api/integrations/shopify/staging?status=pending — deliberately
// unfiltered by income_source_id: this is the shared review queue for
// every connected Shopify AND WooCommerce source (see Settings.jsx's
// income sources section, which invalidates this same query after a
// sync), not just the legacy single-shop setup.
const listStaging = asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  res.json({ data: shopifyService.listStaging(status) });
});

// PATCH /api/integrations/shopify/staging/:id — set SKU and/or category on a pending row before approving
const updateStaging = asyncHandler(async (req, res) => {
  const { sku, category_id } = req.body;
  res.json({ data: shopifyService.updateStaging(req.params.id, { sku, category_id }) });
});

// POST /api/integrations/shopify/staging/:id/approve
const approve = asyncHandler(async (req, res) => {
  const product = shopifyService.approve(req.params.id, req.user.storeId, req.user.id);
  res.json({ data: product });
});

// POST /api/integrations/shopify/staging/:id/reject
const reject = asyncHandler(async (req, res) => {
  shopifyService.reject(req.params.id, req.user.id);
  res.status(204).send();
});

// POST /api/integrations/shopify/staging/approve-all
const approveAll = asyncHandler(async (req, res) => {
  const pending = shopifyService.listStaging('pending');
  const results = { approved: 0, failed: [] };
  for (const row of pending) {
    try {
      shopifyService.approve(row.id, req.user.storeId, req.user.id);
      results.approved++;
    } catch (err) {
      results.failed.push({ id: row.id, name: row.name, error: err.message });
    }
  }
  res.json({ data: results });
});

module.exports = { connections, sync, listStaging, updateStaging, approve, reject, approveAll };
