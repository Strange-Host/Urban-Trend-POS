const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const onlineOrders = require('../services/onlineOrders.service');

// GET /api/orders/online-sources
const sources = asyncHandler(async (req, res) => {
  res.json({ data: onlineOrders.listConnections() });
});

// POST /api/orders/pull-online  { income_source_id, days? }
const pull = asyncHandler(async (req, res) => {
  const { income_source_id: id, days } = req.body || {};
  if (!Number.isInteger(id) || id < 1) throw new ApiError(400, 'income_source_id is required.');
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) throw new ApiError(400, 'days must be a whole number between 1 and 365.');
  const result = await onlineOrders.pullOrders({ incomeSourceId: id, storeId: req.user.storeId, userId: req.user.id, days });
  res.json({ data: result });
});

module.exports = { sources, pull };
