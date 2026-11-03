const asyncHandler = require('../utils/asyncHandler');
const homeFeed = require('../services/homeFeed.service');

// GET /api/v1/home/attention - what is waiting on this person. Cached on the server for ~45 s per person.
// An empty list is a normal answer (a cashier has nothing to decide), never an error.
const attention = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, max-age=30');
  res.json(homeFeed.attention(req.user));
});

// GET /api/v1/home/summary - the "today" strip. Whole-shop figures with reports.view, otherwise just your own till.
const summary = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, max-age=30');
  res.json(homeFeed.summary(req.user));
});

module.exports = { attention, summary };
