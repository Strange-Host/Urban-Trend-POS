const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/staffLogs.service');

// GET /api/staff-logs?staff_id=&entity_type=&action=&from=&to=&page=&limit=
const list = asyncHandler(async (req, res) => {
  res.json(svc.listStaffLogs({ query: req.query }));
});

// GET /api/staff-logs/stats?from=&to=
const stats = asyncHandler(async (req, res) => {
  res.json(svc.staffLogStats({ query: req.query }));
});

module.exports = { list, stats };
