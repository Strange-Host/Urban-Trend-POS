const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { parsePagination, paginatedResponse } = require('../utils/paginate');
const usersService = require('./users.service');
const securityAlerts = require('./securityAlerts.service');
const modules = require('./modules.service');

const actorOf = (user) => ({ id: user.id, name: user.name });

// An admin can look at, and add staff to, another branch (an outlet) by naming it; everyone else stays in their own.
// Editing or removing outlet staff is still done from that branch's own admin account.
function targetStoreId({ user }, source) {
  const wanted = source && source.store_id;
  if (!wanted || Number(wanted) === user.storeId || !modules.isEnabled('branches')) return user.storeId;
  if (user.role !== 'admin') throw new ApiError(403, 'You can only manage staff in your own branch.');
  const store = db.prepare('SELECT id, is_active FROM stores WHERE id = ?').get(Number(wanted));
  if (!store || !store.is_active) throw new ApiError(400, 'That branch does not exist (or is switched off).');
  return store.id;
}

// GET /api/staff?role=&status=&search=&page=&limit=
function listStaff({ query, user }) {
  const { page, limit, offset } = parsePagination(query);
  const { rows, total } = usersService.list({
    storeId: targetStoreId({ user }, query), role: query.role, status: query.status, search: query.search, limit, offset,
  });
  return paginatedResponse({ rows, total, page, limit });
}

// GET /api/staff/:id
function getStaff({ params, user: reqUser }) {
  const user = usersService.getById({ id: params.id, storeId: reqUser.storeId });
  if (!user) throw new ApiError(404, 'Staff member not found.');
  return { data: user };
}

// POST /api/staff  { name, email, phone, password, pin, role }
async function createStaff({ body, user: reqUser }) {
  const { name, email, phone, password, pin, role } = body;
  const storeId = targetStoreId({ user: reqUser }, body);
  const user = await usersService.create({ storeId, staffId: reqUser.id, name, email, phone, password, pin, role });
  securityAlerts.staffEvent({ storeId, actor: actorOf(reqUser), kind: 'created', subjectName: `${user.name} (${user.role})`, subjectId: user.id });
  return { data: user };
}

// PATCH /api/staff/:id  { name, phone, email, role, status, password?, pin? }
async function updateStaff({ params, user: reqUser, body }) {
  const before = usersService.getById({ id: params.id, storeId: reqUser.storeId });
  const user = await usersService.update({
    id: params.id, storeId: reqUser.storeId, staffId: reqUser.id,
    name: body.name, email: body.email, phone: body.phone, role: body.role,
    status: body.status, password: body.password, pin: body.pin,
  });
  if (!user) throw new ApiError(404, 'Staff member not found.');
  const actor = actorOf(reqUser);
  if (before && before.role !== user.role) {
    securityAlerts.staffEvent({ storeId: reqUser.storeId, actor, kind: 'role_changed', subjectName: user.name, subjectId: user.id, detail: `${before.role} to ${user.role}.` });
  }
  if (before && before.status === 'inactive' && user.status === 'active') {
    securityAlerts.staffEvent({ storeId: reqUser.storeId, actor, kind: 'reactivated', subjectName: user.name, subjectId: user.id });
  }
  if (body.password) {
    securityAlerts.staffEvent({ storeId: reqUser.storeId, actor, kind: 'password_reset', subjectName: user.name, subjectId: user.id, detail: 'A new password was typed in by an admin.' });
  }
  return { data: user };
}

// DELETE /api/staff/:id — soft delete
function removeStaff({ params, user: reqUser }) {
  const user = usersService.remove({ id: params.id, storeId: reqUser.storeId, requestingStaffId: reqUser.id });
  if (!user) throw new ApiError(404, 'Staff member not found.');
  securityAlerts.staffEvent({ storeId: reqUser.storeId, actor: actorOf(reqUser), kind: 'deactivated', subjectName: user.name, subjectId: user.id });
  return;
}

// POST /api/staff/:id/reset-password
async function resetStaffPassword({ params, user }) {
  const result = await usersService.resetPassword({ id: params.id, storeId: user.storeId, staffId: user.id });
  if (!result) throw new ApiError(404, 'Staff member not found.');
  const target = usersService.getById({ id: params.id, storeId: user.storeId });
  securityAlerts.staffEvent({ storeId: user.storeId, actor: actorOf(user), kind: 'password_reset', subjectName: target.name, subjectId: target.id, detail: 'A temporary password was issued. They must choose a new one at their next sign-in.' });
  // Returned once, in-band — there's no email/SMS delivery in this build (out of scope per the doc).
  return { data: result };
}

// GET /api/staff/:id/permissions — admin: the editor's data (defaults, overrides, effective)
function getStaffPermissions({ user, params }) {
  return { data: require('./permissions.service').describeForUser({ storeId: user.storeId, userId: Number(params.id) }) };
}

// PUT /api/staff/:id/permissions  { overrides: { "reports.view": true, "sales.void": false, "expenses.approve": null } }
function setStaffPermissions({ body, user, params }) {
  const overrides = body?.overrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new ApiError(400, 'overrides must be an object of permission → true | false | null.');
  for (const v of Object.values(overrides)) {
    if (v !== true && v !== false && v !== null) throw new ApiError(400, 'Each override must be true, false or null.');
  }
  const data = require('./permissions.service').setOverrides({ storeId: user.storeId, actorId: user.id, userId: Number(params.id), overrides });
  const target = usersService.getById({ id: params.id, storeId: user.storeId });
  if (target) securityAlerts.staffEvent({ storeId: user.storeId, actor: actorOf(user), kind: 'permissions_changed', subjectName: target.name, subjectId: target.id });
  return { data };
}

// PATCH /api/staff/:id/two-factor  { enabled: true|false }
function setStaffTwoFactor({ body, user, params }) {
  if (typeof body?.enabled !== 'boolean') throw new ApiError(400, 'enabled must be true or false.');
  const data = require('./twoFactor.service').setEnabled({ storeId: user.storeId, actorId: user.id, userId: Number(params.id), enabled: body.enabled });
  const target = usersService.getById({ id: params.id, storeId: user.storeId });
  if (target) securityAlerts.staffEvent({ storeId: user.storeId, actor: actorOf(user), kind: 'two_factor_changed', subjectName: target.name, subjectId: target.id, detail: `Sign-in codes were switched ${body.enabled ? 'on' : 'off'}.` });
  return { data };
}

// ---- removing an account for real (see services/users.service.js for the three kinds) -------------------------------
// GET /api/staff/:id/removal-check - what is possible with this account, and why not
function staffRemovalCheck({ params, user }) {
  const check = usersService.removalCheck({ id: params.id, storeId: user.storeId, requestingStaffId: user.id });
  if (!check) throw new ApiError(404, 'Staff member not found.');
  return { data: check };
}

// POST /api/staff/:id/reactivate
async function reactivateStaff({ params, user: reqUser }) {
  const user = await usersService.reactivate({ id: params.id, storeId: reqUser.storeId, staffId: reqUser.id });
  if (!user) throw new ApiError(404, 'Staff member not found.');
  securityAlerts.staffEvent({ storeId: reqUser.storeId, actor: actorOf(reqUser), kind: 'reactivated', subjectName: user.name, subjectId: user.id });
  return { data: user };
}

// POST /api/staff/:id/permanent-delete  { confirmName }  - only for accounts that never did anything
function permanentlyDeleteStaff({ params, user, body }) {
  const target = usersService.getById({ id: params.id, storeId: user.storeId });
  if (!target) throw new ApiError(404, 'Staff member not found.');
  if (String(body?.confirmName || '').trim() !== target.name) throw new ApiError(400, "Type the person's full name to confirm.", null, 'CONFIRMATION_MISMATCH');
  const gone = usersService.deletePermanently({ id: params.id, storeId: user.storeId, requestingStaffId: user.id });
  securityAlerts.staffEvent({ storeId: user.storeId, actor: actorOf(user), kind: 'deleted', subjectName: gone.name, detail: `${gone.role} account ${gone.email} had no activity and was deleted.` });
  return { data: { deleted: true, id: gone.id } };
}

// POST /api/staff/:id/erase-personal-data  { confirmName }  - former staff with history: wipe their details, keep the records
async function eraseStaffPersonalData({ params, user: reqUser, body }) {
  const target = usersService.getById({ id: params.id, storeId: reqUser.storeId });
  if (!target) throw new ApiError(404, 'Staff member not found.');
  if (String(body?.confirmName || '').trim() !== target.name) throw new ApiError(400, "Type the person's full name to confirm.", null, 'CONFIRMATION_MISMATCH');
  const user = await usersService.erasePersonalData({ id: params.id, storeId: reqUser.storeId, requestingStaffId: reqUser.id });
  securityAlerts.staffEvent({ storeId: reqUser.storeId, actor: actorOf(reqUser), kind: 'erased', subjectName: target.name, subjectId: user.id, detail: 'Name, email, phone, password and HR documents were erased. Sales and records they handled are kept under "Former staff".' });
  return { data: user };
}

// POST /api/staff/:id/sign-out-everywhere
function signOutStaffEverywhere({ params, user }) {
  const result = usersService.signOutEverywhere({ id: params.id, storeId: user.storeId });
  if (!result) throw new ApiError(404, 'Staff member not found.');
  securityAlerts.staffEvent({ storeId: user.storeId, actor: actorOf(user), kind: 'signed_out_everywhere', subjectName: result.user.name, subjectId: result.user.id });
  return { data: { ended: result.ended } };
}

// GET /api/staff/:id/sessions
function listStaffSessions({ params, user }) {
  const list = usersService.sessionsFor({ id: params.id, storeId: user.storeId });
  if (!list) throw new ApiError(404, 'Staff member not found.');
  return { data: list };
}

// POST /api/staff/:id/unlock-account - lift a wrong-password/PIN lockout
function unlockStaffAccount({ params, user: reqUser }) {
  const user = usersService.unlockAccount({ id: params.id, storeId: reqUser.storeId });
  if (!user) throw new ApiError(404, 'Staff member not found.');
  return { data: user };
}

module.exports = { listStaff, getStaff, createStaff, updateStaff, removeStaff, resetStaffPassword, getStaffPermissions, setStaffPermissions, setStaffTwoFactor, staffRemovalCheck, reactivateStaff, permanentlyDeleteStaff, eraseStaffPersonalData, signOutStaffEverywhere, listStaffSessions, unlockStaffAccount };
