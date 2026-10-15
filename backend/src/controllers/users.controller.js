const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const usersService = require('../services/users.service');

// GET /api/staff?role=&status=&search=&page=&limit=
const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { rows, total } = usersService.list({
    storeId: req.user.storeId, role: req.query.role, status: req.query.status, search: req.query.search, limit, offset,
  });
  res.json(paginatedResponse({ rows, total, page, limit }));
});

// GET /api/staff/:id
const getById = asyncHandler(async (req, res) => {
  const user = usersService.getById({ id: req.params.id, storeId: req.user.storeId });
  if (!user) throw new ApiError(404, 'Staff member not found.');
  res.json({ data: user });
});

// POST /api/staff  { name, email, phone, password, pin, role }
const create = asyncHandler(async (req, res) => {
  const { name, email, phone, password, pin, role } = req.body;
  const user = usersService.create({ storeId: req.user.storeId, staffId: req.user.id, name, email, phone, password, pin, role });
  res.status(201).json({ data: user });
});

// PATCH /api/staff/:id  { name, phone, email, role, status, password?, pin? }
const update = asyncHandler(async (req, res) => {
  const user = usersService.update({
    id: req.params.id, storeId: req.user.storeId, staffId: req.user.id,
    name: req.body.name, email: req.body.email, phone: req.body.phone, role: req.body.role,
    status: req.body.status, password: req.body.password, pin: req.body.pin,
  });
  if (!user) throw new ApiError(404, 'Staff member not found.');
  res.json({ data: user });
});

// DELETE /api/staff/:id — soft delete
const remove = asyncHandler(async (req, res) => {
  const user = usersService.remove({ id: req.params.id, storeId: req.user.storeId, requestingStaffId: req.user.id });
  if (!user) throw new ApiError(404, 'Staff member not found.');
  res.status(204).send();
});

// POST /api/staff/:id/reset-password
const resetPassword = asyncHandler(async (req, res) => {
  const result = usersService.resetPassword({ id: req.params.id, storeId: req.user.storeId, staffId: req.user.id });
  if (!result) throw new ApiError(404, 'Staff member not found.');
  // Returned once, in-band — there's no email/SMS delivery in this build (out of scope per the doc).
  res.json({ data: result });
});

// GET /api/staff/:id/permissions — admin: the editor's data (defaults, overrides, effective)
const getPermissions = asyncHandler(async (req, res) => {
  res.json({ data: require('../services/permissions.service').describeForUser({ storeId: req.user.storeId, userId: Number(req.params.id) }) });
});

// PUT /api/staff/:id/permissions  { overrides: { "reports.view": true, "sales.void": false, "payroll.view": null } }
const setPermissions = asyncHandler(async (req, res) => {
  const overrides = req.body?.overrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new ApiError(400, 'overrides must be an object of permission → true | false | null.');
  for (const v of Object.values(overrides)) {
    if (v !== true && v !== false && v !== null) throw new ApiError(400, 'Each override must be true, false or null.');
  }
  res.json({ data: require('../services/permissions.service').setOverrides({ storeId: req.user.storeId, actorId: req.user.id, userId: Number(req.params.id), overrides }) });
});

// PATCH /api/staff/:id/two-factor  { enabled: true|false }
const setTwoFactor = asyncHandler(async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') throw new ApiError(400, 'enabled must be true or false.');
  res.json({ data: require('../services/twoFactor.service').setEnabled({ storeId: req.user.storeId, actorId: req.user.id, userId: Number(req.params.id), enabled: req.body.enabled }) });
});

module.exports = { list, getById, create, update, remove, resetPassword, getPermissions, setPermissions, setTwoFactor };
