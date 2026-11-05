const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/security.service');

// GET /api/security/policy
const getPolicy = asyncHandler(async (req, res) => {
  res.json(svc.getPolicy());
});

// PUT /api/security/policy - the whole policy (or any part of it); validated here, never through the generic settings route
const updatePolicy = asyncHandler(async (req, res) => {
  res.json(svc.updatePolicy({ body: req.body, user: req.user }));
});

// GET /api/security/events?limit=50 - latest lockouts, resets, erasures, large refunds...
const listEvents = asyncHandler(async (req, res) => {
  res.json(svc.listEvents({ query: req.query, user: req.user }));
});

module.exports = { getPolicy, updatePolicy, listEvents };
