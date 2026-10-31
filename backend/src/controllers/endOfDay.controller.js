const asyncHandler = require('../utils/asyncHandler');
const endOfDay = require('../services/endOfDay.service');

// GET /api/end-of-day?date=YYYY-MM-DD — reassigned work, attendance and handover notes for one day (default today).
const get = asyncHandler(async (req, res) => {
  res.json({ data: endOfDay.getDay({ storeId: req.user.storeId, date: req.query.date }) });
});

// POST /api/end-of-day/approve { date?, note? } — the manager signs off the day.
const approve = asyncHandler(async (req, res) => {
  const data = endOfDay.approve({
    storeId: req.user.storeId, userId: req.user.id, userName: req.user.name,
    date: req.body?.date, note: req.body?.note, acknowledged: req.body?.acknowledged,
  });
  res.status(201).json({ data });
});

module.exports = { get, approve };
