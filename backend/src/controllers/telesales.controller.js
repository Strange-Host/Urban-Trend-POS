const asyncHandler = require('../utils/asyncHandler');
const telesalesDistribution = require('../services/telesalesDistribution.service');
const settingsService = require('../services/settings.service');

// POST /api/telesales/rebalance — admin-triggerable manual sweep, same
// pattern as POST /api/inventory/reconcile and POST /api/orders/expire-unconfirmed.
// server.js also runs this every 15 minutes; this exists for on-demand runs/testing.
const rebalance = asyncHandler(async (req, res) => {
  const settings = settingsService.getAll();
  const cutoffHour = parseInt(settings.telesales_cutoff_hour, 10) || 10;
  const moved = telesalesDistribution.rebalanceStaleAssignments({ storeId: req.user.storeId, cutoffHour });
  res.json({ data: moved });
});

module.exports = { rebalance };
