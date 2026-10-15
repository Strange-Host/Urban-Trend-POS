const asyncHandler = require('../utils/asyncHandler');
const shiftService = require('../services/shift.service');

// GET /api/shift/handover — the signed-in person's own open items
const handover = asyncHandler(async (req, res) => {
  res.json({ data: shiftService.getHandover({ userId: req.user.id, storeId: req.user.storeId }) });
});

module.exports = { handover };
