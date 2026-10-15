const router = require('express').Router();
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { authenticate, requireRole } = require('../middleware/auth');
const modules = require('../services/modules.service');

router.use(authenticate);

// Everyone signed in can read the switches (the menu needs them); only an admin can change them.
router.get('/', asyncHandler(async (_req, res) => { res.json({ data: modules.getAll() }); }));

router.put('/', requireRole('admin'), asyncHandler(async (req, res) => {
  const body = req.body || {};
  const known = Object.keys(modules.KEYS);
  const unknown = Object.keys(body).filter((k) => !known.includes(k));
  if (unknown.length || known.every((k) => body[k] === undefined)) {
    throw new ApiError(400, `Send ${known.join(' and/or ')} as true or false.`);
  }
  for (const k of known) {
    if (body[k] !== undefined && typeof body[k] !== 'boolean') throw new ApiError(400, `${k} must be true or false.`);
  }
  res.json({ data: modules.setMany(body, req.user.id) });
}));

module.exports = router;
