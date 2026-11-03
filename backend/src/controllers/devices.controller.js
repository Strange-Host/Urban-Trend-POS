const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const devices = require('../services/devices.service');

// POST /api/v1/devices  { deviceId?, name?, platform?, appVersion?, pushToken? }
// Registers (or updates) the phone this request came from. Call it after sign-in, whenever FCM hands out a new token,
// and after an app update. pushToken: null switches notifications off for this phone.
const register = asyncHandler(async (req, res) => {
  res.status(200).json({ device: devices.register(req.session, req.body) });
});

// GET /api/v1/devices            - your own phones
// GET /api/v1/devices?all=1      - every phone in the business (admin only)
const list = asyncHandler(async (req, res) => {
  if (req.query.all === '1' || req.query.all === 'true') {
    if (req.user.role !== 'admin') throw new ApiError(403, 'Only an admin can see every device.', null, 'FORBIDDEN');
    return res.json({ devices: devices.listAll(req.session.id) });
  }
  res.json({ devices: devices.listForUser(req.user.id, req.session.id) });
});

// DELETE /api/v1/devices/:id - sign a phone out. Your own, or any phone for an admin.
const revoke = asyncHandler(async (req, res) => {
  res.json(devices.revoke(req.params.id, req.user));
});

module.exports = { register, list, revoke };
