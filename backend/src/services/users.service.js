const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const authTokens = require('./authTokens.service');
const { assertValidPin } = require('../utils/pin');
const { assertStrongPassword } = require('../utils/passwordPolicy');
const sessionsService = require('./sessions.service');
const loginGuard = require('./loginGuard.service');

const VALID_ROLES = ['admin', 'manager', 'cashier'];

// This module doubles as the Staff module (§5) — it operates on the
// existing `users` table rather than a parallel `staff` table, since JWTs
// already carry a user id and duplicating identity would risk drift.
const stillLocked = (until) => Boolean(until) && Date.parse(until) > Date.now();
const safe = ({ password_hash, pin_code_hash, failed_login_count, pin_failed_count, ...rest }) => ({
  ...rest,
  status: rest.is_active ? 'active' : 'inactive',
  locked: stillLocked(rest.locked_until) || stillLocked(rest.pin_locked_until),   // a sign-in lock an admin can lift
  erased: Boolean(rest.erased_at),
});

function list({ storeId, role, status, search, limit, offset }) {
  const where = ['store_id = ?'];
  const params = [storeId];

  if (role) { where.push('role = ?'); params.push(role); }
  if (status) { where.push('is_active = ?'); params.push(status === 'active' ? 1 : 0); }
  if (search) {
    where.push('(name LIKE ? OR phone LIKE ? OR email LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const rows = db.prepare(`SELECT * FROM users ${whereSql} ORDER BY name ASC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) c FROM users ${whereSql}`).get(...params).c;

  return { rows: rows.map(safe), total };
}

function getById({ id, storeId }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND store_id = ?').get(id, storeId);
  return user ? safe(user) : null;
}

function create({ storeId, staffId, name, email, phone, password, pin, role }) {
  if (!name || !phone || !password || !role) {
    throw new ApiError(400, 'name, phone, password, and role are required.');
  }
  if (!VALID_ROLES.includes(role)) {
    throw new ApiError(400, `role must be one of ${VALID_ROLES.join(', ')}.`);
  }
  if (!email) throw new ApiError(400, 'email is required.');
  const normalizedEmail = email.trim().toLowerCase();

  assertValidPin(pin);
  assertStrongPassword(password, { role, email: normalizedEmail, name, phone });
  const passwordHash = bcrypt.hashSync(password, 10);
  const pinHash = pin ? bcrypt.hashSync(pin, 10) : null;

  const result = db.prepare(`
    INSERT INTO users (store_id, name, email, phone, password_hash, pin_code_hash, role, password_changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(storeId, name, normalizedEmail, phone, passwordHash, pinHash, role);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId, action: 'create', entityType: 'staff', entityId: user.id, after: safe(user) });
  return safe(user);
}

function update({ id, storeId, staffId, name, email, phone, role, status, password, pin }) {
  const existing = db.prepare('SELECT * FROM users WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!existing) return null;
  if (existing.erased_at) throw new ApiError(400, "This account's personal data was erased, so it can no longer be changed or reactivated. Create a new account instead.", null, 'ACCOUNT_ERASED');

  assertValidPin(pin);
  const finalName = name ?? existing.name;
  const finalEmail = email ? email.trim().toLowerCase() : existing.email;
  const finalPhone = phone ?? existing.phone;
  const finalRole = role ?? existing.role;
  const isActive = status ? (status === 'active' ? 1 : 0) : existing.is_active;
  const passwordHash = password ? bcrypt.hashSync(password, 10) : existing.password_hash;
  const pinHash = pin ? bcrypt.hashSync(pin, 10) : existing.pin_code_hash;

  if (finalRole !== existing.role && !VALID_ROLES.includes(finalRole)) {
    throw new ApiError(400, `role must be one of ${VALID_ROLES.join(', ')}.`);
  }
  if (password) assertStrongPassword(password, { role: finalRole, email: finalEmail, name: finalName, phone: finalPhone });
  // Switching an account back on starts it with a clean sign-in record.
  const reactivating = existing.is_active === 0 && isActive === 1;

  // Revoke any outstanding JWT (and refresh token) immediately on a
  // password change or a deactivation, rather than letting it keep
  // working until it naturally expires (see middleware/auth.js).
  const revokesToken = Boolean(password) || (existing.is_active === 1 && isActive === 0);

  db.prepare(`
    UPDATE users SET name=?, email=?, phone=?, role=?, is_active=?, password_hash=?, pin_code_hash=?,
      token_version = token_version + ?, password_changed_at = CASE WHEN ? THEN datetime('now') ELSE password_changed_at END,
      updated_at=datetime('now')
    WHERE id=?
  `).run(finalName, finalEmail, finalPhone, finalRole, isActive, passwordHash, pinHash, revokesToken ? 1 : 0, password ? 1 : 0, id);
  if (revokesToken) authTokens.revokeAllForUser(id);
  if (reactivating) loginGuard.clearLocks(id);
  // A different role means different timing rules and permissions: end their sessions so they sign in under the new role.
  if (finalRole !== existing.role) { db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(id); authTokens.revokeAllForUser(id); }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  // Role escalation/deactivation is security-relevant (§5.3) — always logged, same as any other field change.
  logStaffAction({ staffId, action: 'update', entityType: 'staff', entityId: user.id, before: safe(existing), after: safe(user) });
  return safe(user);
}

// Soft delete: sets status inactive, never removes the row (§5.4)
function remove({ id, storeId, requestingStaffId }) {
  const existing = db.prepare('SELECT * FROM users WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!existing) return null;
  if (requestingStaffId === Number(id)) throw new ApiError(400, 'You cannot deactivate your own account.');

  db.prepare(`UPDATE users SET is_active = 0, token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?`).run(id);
  authTokens.revokeAllForUser(id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  logStaffAction({ staffId: requestingStaffId, action: 'update', entityType: 'staff', entityId: user.id, before: safe(existing), after: safe(user) });
  return safe(user);
}

// Admin-triggered, generates a temp password (§5.3)
function resetPassword({ id, storeId, staffId }) {
  const existing = db.prepare('SELECT * FROM users WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!existing) return null;

  if (existing.erased_at) throw new ApiError(400, 'This account was erased and cannot be used.', null, 'ACCOUNT_ERASED');
  const tempPassword = crypto.randomBytes(9).toString('base64url'); // 12 characters, e.g. "kQ3f9RtZb2Xe"
  const passwordHash = bcrypt.hashSync(tempPassword, 10);
  // A temporary password only lets the person set a real one (same rule as the seeded admin password).
  db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?`).run(passwordHash, id);
  authTokens.revokeAllForUser(id);
  loginGuard.clearLocks(id);

  logStaffAction({ staffId, action: 'update', entityType: 'staff', entityId: existing.id, before: {}, after: { password_reset: true } });
  return { id: existing.id, temporaryPassword: tempPassword };
}

// ---------------------------------------------------------------------------------------------------------------------
// Removing a staff account for real
// ---------------------------------------------------------------------------------------------------------------------
// Dozens of tables point at a staff member (sales, cash sessions, stock changes, logs...). Deleting the row would
// orphan or destroy that history, so there are three honest ways to "remove" someone:
//   A. Deactivate  - remove() above: they can't sign in, everything they did stays, and they can be reactivated.
//   B. Delete permanently - ONLY when the account never did anything (a test account, a mistake). Checked against
//      every table that references users, found from the database itself so new tables are covered automatically.
//   C. Erase personal data - for former staff who have history: name, email, phone, password, PIN and HR documents are
//      wiped; the account stays as "Former staff #N" so receipts, sales and reports still add up.

// Columns that only hold the person's OWN sign-in/convenience data: deleted along with the account, not "activity".
const OWN_DATA = new Set(['refresh_tokens.user_id', 'auth_sessions.user_id', 'notifications.user_id', 'user_permissions.user_id', 'otp_challenges.user_id']);
// Columns that merely note who last touched something: set to empty when the account is deleted.
const NULLABLE_REFS = new Set(['settings.updated_by']);

const LABELS = {
  sales: 'sales', cash_sessions: 'cash sessions', inventory_movements: 'stock changes', orders: 'orders',
  order_status_history: 'order updates', payment_notifications: 'payment reviews', shopify_staging_products: 'product-sync reviews',
  staff_logs: 'logged actions', staff_attendance: 'attendance records', payroll_adjustments: 'payroll entries',
  employee_documents: 'HR documents', employee_agreements: 'signed agreements', leads: 'leads', lead_activities: 'lead notes',
  lead_status_history: 'lead updates', requisitions: 'requisitions', expenses: 'expenses', payment_records: 'payment records',
  lead_form_routes: 'website-form routes', user_permissions: 'permission changes',
};

function referencesTo(userId) {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all();
  const found = [];
  for (const { name } of tables) {
    for (const fk of db.pragma(`foreign_key_list(${name})`)) {
      if (fk.table !== 'users') continue;
      const key = `${name}.${fk.from}`;
      const { c } = db.prepare(`SELECT COUNT(*) AS c FROM "${name}" WHERE "${fk.from}" = ?`).get(userId);
      if (c > 0) found.push({ table: name, column: fk.from, key, count: c, own: OWN_DATA.has(key), nullable: NULLABLE_REFS.has(key) });
    }
  }
  return found;
}

function activeAdminCount(storeId, exceptId) {
  return db.prepare(`SELECT COUNT(*) c FROM users WHERE store_id = ? AND role = 'admin' AND is_active = 1 AND id != ?`).get(storeId, exceptId).c;
}

/** What can be done with this account, and why not. Drives the buttons on the Staff page. */
function removalCheck({ id, storeId, requestingStaffId }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!user) return null;
  const isSelf = requestingStaffId === Number(id);
  const lastAdmin = user.role === 'admin' && user.is_active === 1 && activeAdminCount(storeId, user.id) === 0;

  const blocking = referencesTo(user.id).filter((r) => !r.own && !r.nullable);
  const activity = {};
  for (const r of blocking) { const label = LABELS[r.table] || r.table.replace(/_/g, ' '); activity[label] = (activity[label] || 0) + r.count; }

  const reasons = [];
  if (isSelf) reasons.push('You cannot remove your own account.');
  if (lastAdmin) reasons.push('This is the only active admin. Make another admin first.');
  const hasActivity = Object.keys(activity).length > 0;
  if (hasActivity) reasons.push(`This account has history (${Object.entries(activity).map(([k, v]) => `${v} ${k}`).join(', ')}), which must be kept.`);

  return {
    id: user.id, name: user.name, role: user.role, active: user.is_active === 1, erased: Boolean(user.erased_at),
    activity, hasActivity,
    canDeletePermanently: !isSelf && !lastAdmin && !hasActivity,
    canErase: !isSelf && !lastAdmin && user.is_active === 0 && !user.erased_at,
    eraseNeedsDeactivation: user.is_active === 1 && !user.erased_at,
    reasons,
  };
}

function reactivate({ id, storeId, staffId }) {
  const existing = db.prepare('SELECT * FROM users WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!existing) return null;
  if (existing.erased_at) throw new ApiError(400, "This account's personal data was erased, so it cannot be reactivated. Create a new account instead.", null, 'ACCOUNT_ERASED');
  if (existing.is_active === 1) return safe(existing);
  return update({ id, storeId, staffId, status: 'active' });
}

/** B: delete an account that never did anything. Returns a snapshot of what was deleted (for the alert). */
function deletePermanently({ id, storeId, requestingStaffId }) {
  const check = removalCheck({ id, storeId, requestingStaffId });
  if (!check) return null;
  if (!check.canDeletePermanently) throw new ApiError(409, check.reasons.join(' ') || 'This account cannot be deleted.', { activity: check.activity }, 'CANNOT_DELETE_ACCOUNT');

  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  db.transaction(() => {
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(id);      // before sessions: refresh tokens point at them
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM otp_challenges WHERE user_id = ?').run(id);
    db.prepare('UPDATE settings SET updated_by = NULL WHERE updated_by = ?').run(id);
    logStaffAction({ staffId: requestingStaffId, action: 'delete', entityType: 'staff', entityId: existing.id, before: safe(existing) });
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();
  return { id: existing.id, name: existing.name, email: existing.email, role: existing.role };
}

/** C: wipe a former staff member's personal data but keep the account (and so all their history). */
function erasePersonalData({ id, storeId, requestingStaffId }) {
  const check = removalCheck({ id, storeId, requestingStaffId });
  if (!check) return null;
  if (check.erased) throw new ApiError(400, 'This account was already erased.', null, 'ACCOUNT_ERASED');
  if (check.eraseNeedsDeactivation) throw new ApiError(409, 'Deactivate the account first, then erase its personal data.', null, 'DEACTIVATE_FIRST');
  if (!check.canErase) throw new ApiError(409, check.reasons.join(' ') || 'This account cannot be erased.', null, 'CANNOT_ERASE_ACCOUNT');

  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const label = `Former staff #${id}`;
  const unusable = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);   // nobody knows it; the account can't sign in anyway
  db.transaction(() => {
    db.prepare(`
      UPDATE users SET name = ?, email = ?, phone = ?, password_hash = ?, pin_code_hash = NULL, two_factor_enabled = 0,
        must_change_password = 0, token_version = token_version + 1, failed_login_count = 0, locked_until = NULL,
        pin_failed_count = 0, pin_locked_until = NULL, is_active = 0, erased_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(label, `erased-${id}@removed.invalid`, `erased-${id}`, unusable, id);
    db.prepare('DELETE FROM employee_documents WHERE staff_id = ?').run(id);
    db.prepare('UPDATE employee_agreements SET signed_name = ? WHERE staff_id = ?').run(label, id);
    db.prepare('DELETE FROM user_permissions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM otp_challenges WHERE user_id = ?').run(id);
    // The audit trail of changes to this account holds old names/emails/phones: keep the entries, drop the contents.
    db.prepare(`UPDATE staff_logs SET changes = '{"erased":true}' WHERE entity_type = 'staff' AND entity_id = ?`).run(id);
    logStaffAction({ staffId: requestingStaffId, action: 'update', entityType: 'staff', entityId: id, before: {}, after: { personal_data_erased: true } });
  })();
  authTokens.revokeAllForUser(id);
  return safe(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

/** Ends every sign-in this person has, on every device. Returns how many were ended. */
function signOutEverywhere({ id, storeId }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!user) return null;
  return { user: safe(user), ended: sessionsService.revokeAllForUser(id, { reason: 'signed_out_by_admin' }) };
}

function sessionsFor({ id, storeId }) {
  const user = db.prepare('SELECT id, role FROM users WHERE id = ? AND store_id = ?').get(id, storeId);
  return user ? sessionsService.listForUser(user, null) : null;
}

/** Lifts a sign-in lock right now (wrong password/PIN lockout). */
function unlockAccount({ id, storeId }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!user) return null;
  loginGuard.clearLocks(id);
  return safe(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

module.exports = { safe, list, getById, create, update, remove, resetPassword, removalCheck, reactivate, deletePermanently, erasePersonalData, signOutEverywhere, sessionsFor, unlockAccount };
