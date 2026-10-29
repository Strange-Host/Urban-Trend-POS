const asyncHandler = require('../utils/asyncHandler');
const custodyService = require('../services/custody.service');

// GET /api/custody — shop cash still in someone's hands
const list = asyncHandler(async (req, res) => {
  res.json({ data: custodyService.listOpen({ storeId: req.user.storeId }) });
});

// POST /api/custody/:id/deposit
const deposit = asyncHandler(async (req, res) => {
  res.json({ data: custodyService.deposit({ custodyId: Number(req.params.id), storeId: req.user.storeId, staffId: req.user.id }) });
});

module.exports = { list, deposit };
