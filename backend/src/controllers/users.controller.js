const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const usersService = require('../services/users.service');
const securityAlerts = require('../services/securityAlerts.service');

const actorOf = (req) => ({ id: req.user.id, name: req.user.name });

// An admin can look at, and add staff to, another branch (an outlet) by naming it; everyone else stays in their own.
// Editing or removing outlet staff is still done from that branch's own admin account.
function targetStoreId(req, source) {
  const wanted = source && source.store_id;
  if (!wanted || Number(wanted) === req.user.storeId) return req.user.storeId;
  if (req.user.role !== 'admin') throw new ApiError(403, 'You can only manage staff in your own branch.');
  const store = db.prepare('SELECT id, is_active FROM stores WHERE id = ?').get(Number(wanted));
  if (!store || !store.is_active) throw new ApiError(400, 'That branch does not exist (or is switched off).');
  return store.id;
}

// GET /api/staff?role=&status=&search=&page=&limit=
const list = asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { rows, total } = usersService.list({
    storeId: targetStoreId(req, req.query), role: req.query.role, status: req.query.status, search: req.query.search, limit, offset,
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
  const storeId = targetStoreId(req, req.body);
  const user = usersService.create({ storeId, staffId: req.user.id, name, email, phone, password, pin, role });
  securityAlerts.staffEvent({ storeId, actor: actorOf(req), kind: 'created', subjectName: `${user.name} (${user.role})`, subjectId: user.id });
  res.status(201).json({ data: user });
});

// PATCH /api/staff/:id  { name, phone, email, role, status, password?, pin? }
const update = asyncHandler(async (req, res) => {
  const before = usersService.getById({ id: req.params.id, storeId: req.user.storeId });
  const user = usersService.update({
    id: req.params.id, storeId: req.user.storeId, staffId: req.user.id,
    name: req.body.name, email: req.body.email, phone: req.body.phone, role: req.body.role,
    status: req.body.status, password: req.body.password, pin: req.body.pin,
  });
  if (!user) throw new ApiError(404, 'Staff member not found.');
  const actor = actorOf(req);
  if (before && before.role !== user.role) {
    securityAlerts.staffEvent({ storeId: req.user.storeId, actor, kind: 'role_changed', subjectName: user.name, subjectId: user.id, detail: `${before.role} to ${user.role}.` });
  }
  if (before && before.status === 'inactive' && user.status === 'active') {
    securityAlerts.staffEvent({ storeId: req.user.storeId, actor, kind: 'reactivated', subjectName: user.name, subjectId: user.id });
  }
  if (req.body.password) {
    securityAlerts.staffEvent({ storeId: req.user.storeId, actor, kind: 'password_reset', subjectName: user.name, subjectId: user.id, detail: 'A new password was typed in by an admin.' });
  }
  res.json({ data: user });
});

// DELETE /api/staff/:id — soft delete
const remove = asyncHandler(async (req, res) => {
  const user = usersService.remove({ id: req.params.id, storeId: req.user.storeId, requestingStaffId: req.user.id });
  if (!user) throw new ApiError(404, 'Staff member not found.');
  securityAlerts.staffEvent({ storeId: req.user.storeId, actor: actorOf(req), kind: 'deactivated', subjectName: user.name, subjectId: user.id });
  res.status(204).send();
});

// POST /api/staff/:id/reset-password
const resetPassword = asyncHandler(async (req, res) => {
  const result = usersService.resetPassword({ id: req.params.id, storeId: req.user.storeId, staffId: req.user.id });
  if (!result) throw new ApiError(404, 'Staff member not found.');
  const target = usersService.getById({ id: req.params.id, storeId: req.user.storeId });
  securityAlerts.staffEvent({ storeId: req.user.storeId, actor: actorOf(req), kind: 'password_reset', subjectName: target.name, subjectId: target.id, detail: 'A temporary password was issued. They must choose a new one at their next sign-in.' });
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
  const data = require('../services/permissions.service').setOverrides({ storeId: req.user.storeId, actorId: req.user.id, userId: Number(req.params.id), overrides });
  const target = usersService.getById({ id: req.params.id, storeId: req.user.storeId });
  if (target) securityAlerts.staffEvent({ storeId: req.user.storeId, actor: actorOf(req), kind: 'permissions_changed', subjectName: target.name, subjectId: target.id });
  res.json({ data });
});

// PATCH /api/staff/:id/two-factor  { enabled: true|false }
const setTwoFactor = asyncHandler(async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') throw new ApiError(400, 'enabled must be true or false.');
  const data = require('../services/twoFactor.service').setEnabled({ storeId: req.user.storeId, actorId: req.user.id, userId: Number(req.params.id), enabled: req.body.enabled });
  const target = usersService.getById({ id: req.params.id, storeId: req.user.storeId });
  if (target) securityAlerts.staffEvent({ storeId: req.user.storeId, actor: actorOf(req), kind: 'two_factor_changed', subjectName: target.name, subjectId: target.id, detail: `Sign-in codes were switched ${req.body.enabled ? 'on' : 'off'}.` });
  res.json({ data });
});

// ---- removing an account for real (see services/users.service.js for the three kinds) -------------------------------
// GET /api/staff/:id/removal-check - what is possible with this account, and why not
const removalCheck = asyncHandler(async (req, res) => {
  const check = usersService.removalCheck({ id: req.params.id, storeId: req.user.storeId, requestingStaffId: req.user.id });
  if (!check) throw new ApiError(404, 'Staff member not found.');
  res.json({ data: check });
});

// POST /api/staff/:id/reactivate
const reactivate = asyncHandler(async (req, res) => {
  const user = usersService.reactivate({ id: req.params.id, storeId: req.user.storeId, staffId: req.user.id });
  if (!user) throw new ApiError(404, 'Staff member not found.');
  securityAlerts.staffEvent({ storeId: req.user.storeId, actor: actorOf(req), kind: 'reactivated', subjectName: user.name, subjectId: user.id });
  res.json({ data: user });
});

// POST /api/staff/:id/permanent-delete  { confirmName }  - only for accounts that never did anything
const permanentDelete = asyncHandler(async (req, res) => {
  const target = usersService.getById({ id: req.params.id, storeId: req.user.storeId });
  if (!target) throw new ApiError(404, 'Staff member not found.');
  if (String(req.body?.confirmName || '').trim() !== target.name) throw new ApiError(400, "Type the person's full name to confirm.", null, 'CONFIRMATION_MISMATCH');
  const gone = usersService.deletePermanently({ id: req.params.id, storeId: req.user.storeId, requestingStaffId: req.user.id });
  securityAlerts.staffEvent({ storeId: req.user.storeId, actor: actorOf(req), kind: 'deleted', subjectName: gone.name, detail: `${gone.role} account ${gone.email} had no activity and was deleted.` });
  res.json({ data: { deleted: true, id: gone.id } });
});

// POST /api/staff/:id/erase-personal-data  { confirmName }  - former staff with history: wipe their details, keep the records
const erasePersonalData = asyncHandler(async (req, res) => {
  const target = usersService.getById({ id: req.params.id, storeId: req.user.storeId });
  if (!target) throw new ApiError(404, 'Staff member not found.');
  if (String(req.body?.confirmName || '').trim() !== target.name) throw new ApiError(400, "Type the person's full name to confirm.", null, 'CONFIRMATION_MISMATCH');
  const user = usersService.erasePersonalData({ id: req.params.id, storeId: req.user.storeId, requestingStaffId: req.user.id });
  securityAlerts.staffEvent({ storeId: req.user.storeId, actor: actorOf(req), kind: 'erased', subjectName: target.name, subjectId: user.id, detail: 'Name, email, phone, password and HR documents were erased. Sales and records they handled are kept under "Former staff".' });
  res.json({ data: user });
});

// POST /api/staff/:id/sign-out-everywhere
const signOutEverywhere = asyncHandler(async (req, res) => {
  const result = usersService.signOutEverywhere({ id: req.params.id, storeId: req.user.storeId });
  if (!result) throw new ApiError(404, 'Staff member not found.');
  securityAlerts.staffEvent({ storeId: req.user.storeId, actor: actorOf(req), kind: 'signed_out_everywhere', subjectName: result.user.name, subjectId: result.user.id });
  res.json({ data: { ended: result.ended } });
});

// GET /api/staff/:id/sessions
const sessionsFor = asyncHandler(async (req, res) => {
  const list = usersService.sessionsFor({ id: req.params.id, storeId: req.user.storeId });
  if (!list) throw new ApiError(404, 'Staff member not found.');
  res.json({ data: list });
});

// POST /api/staff/:id/unlock-account - lift a wrong-password/PIN lockout
const unlockAccount = asyncHandler(async (req, res) => {
  const user = usersService.unlockAccount({ id: req.params.id, storeId: req.user.storeId });
  if (!user) throw new ApiError(404, 'Staff member not found.');
  res.json({ data: user });
});

module.exports = { list, getById, create, update, remove, resetPassword, getPermissions, setPermissions, setTwoFactor, removalCheck, reactivate, permanentDelete, erasePersonalData, signOutEverywhere, sessionsFor, unlockAccount };
