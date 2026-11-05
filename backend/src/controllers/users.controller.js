const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/staffAdmin.service');

// GET /api/staff?role=&status=&search=&page=&limit=
const list = asyncHandler(async (req, res) => {
  res.json(svc.listStaff({ query: req.query, user: req.user }));
});

// GET /api/staff/:id
const getById = asyncHandler(async (req, res) => {
  res.json(svc.getStaff({ params: req.params, user: req.user }));
});

// POST /api/staff  { name, email, phone, password, pin, role }
const create = asyncHandler(async (req, res) => {
  res.status(201).json(await svc.createStaff({ body: req.body, user: req.user }));
});

// PATCH /api/staff/:id  { name, phone, email, role, status, password?, pin? }
const update = asyncHandler(async (req, res) => {
  res.json(await svc.updateStaff({ params: req.params, user: req.user, body: req.body }));
});

// DELETE /api/staff/:id — soft delete
const remove = asyncHandler(async (req, res) => {
  svc.removeStaff({ params: req.params, user: req.user });
  res.status(204).send();
});

// POST /api/staff/:id/reset-password
const resetPassword = asyncHandler(async (req, res) => {
  res.json(await svc.resetStaffPassword({ params: req.params, user: req.user }));
});

// GET /api/staff/:id/permissions — admin: the editor's data (defaults, overrides, effective)
const getPermissions = asyncHandler(async (req, res) => {
  res.json(svc.getStaffPermissions({ user: req.user, params: req.params }));
});

// PUT /api/staff/:id/permissions  { overrides: { "reports.view": true, "sales.void": false, "payroll.view": null } }
const setPermissions = asyncHandler(async (req, res) => {
  res.json(svc.setStaffPermissions({ body: req.body, user: req.user, params: req.params }));
});

// PATCH /api/staff/:id/two-factor  { enabled: true|false }
const setTwoFactor = asyncHandler(async (req, res) => {
  res.json(svc.setStaffTwoFactor({ body: req.body, user: req.user, params: req.params }));
});

// GET /api/staff/:id/removal-check - what is possible with this account, and why not
const removalCheck = asyncHandler(async (req, res) => {
  res.json(svc.staffRemovalCheck({ params: req.params, user: req.user }));
});

// POST /api/staff/:id/reactivate
const reactivate = asyncHandler(async (req, res) => {
  res.json(await svc.reactivateStaff({ params: req.params, user: req.user }));
});

// POST /api/staff/:id/permanent-delete  { confirmName }  - only for accounts that never did anything
const permanentDelete = asyncHandler(async (req, res) => {
  res.json(svc.permanentlyDeleteStaff({ params: req.params, user: req.user, body: req.body }));
});

// POST /api/staff/:id/erase-personal-data  { confirmName }  - former staff with history: wipe their details, keep the records
const erasePersonalData = asyncHandler(async (req, res) => {
  res.json(await svc.eraseStaffPersonalData({ params: req.params, user: req.user, body: req.body }));
});

// POST /api/staff/:id/sign-out-everywhere
const signOutEverywhere = asyncHandler(async (req, res) => {
  res.json(svc.signOutStaffEverywhere({ params: req.params, user: req.user }));
});

// GET /api/staff/:id/sessions
const sessionsFor = asyncHandler(async (req, res) => {
  res.json(svc.listStaffSessions({ params: req.params, user: req.user }));
});

// POST /api/staff/:id/unlock-account - lift a wrong-password/PIN lockout
const unlockAccount = asyncHandler(async (req, res) => {
  res.json(svc.unlockStaffAccount({ params: req.params, user: req.user }));
});

module.exports = { list, getById, create, update, remove, resetPassword, getPermissions, setPermissions, setTwoFactor, removalCheck, reactivate, permanentDelete, erasePersonalData, signOutEverywhere, sessionsFor, unlockAccount };
