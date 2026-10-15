const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { logStaffAction } = require('../utils/auditLog');
const authTokens = require('./authTokens.service');
const { assertValidPin } = require('../utils/pin');

const VALID_ROLES = ['admin', 'manager', 'cashier'];

// This module doubles as the Staff module (§5) — it operates on the
// existing `users` table rather than a parallel `staff` table, since JWTs
// already carry a user id and duplicating identity would risk drift.
const safe = ({ password_hash, pin_code_hash, ...rest }) => ({ ...rest, status: rest.is_active ? 'active' : 'inactive' });

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
  const passwordHash = bcrypt.hashSync(password, 10);
  const pinHash = pin ? bcrypt.hashSync(pin, 10) : null;

  const result = db.prepare(`
    INSERT INTO users (store_id, name, email, phone, password_hash, pin_code_hash, role)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(storeId, name, normalizedEmail, phone, passwordHash, pinHash, role);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  logStaffAction({ staffId, action: 'create', entityType: 'staff', entityId: user.id, after: safe(user) });
  return safe(user);
}

function update({ id, storeId, staffId, name, email, phone, role, status, password, pin }) {
  const existing = db.prepare('SELECT * FROM users WHERE id = ? AND store_id = ?').get(id, storeId);
  if (!existing) return null;

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

  // Revoke any outstanding JWT (and refresh token) immediately on a
  // password change or a deactivation, rather than letting it keep
  // working until it naturally expires (see middleware/auth.js).
  const revokesToken = Boolean(password) || (existing.is_active === 1 && isActive === 0);

  db.prepare(`
    UPDATE users SET name=?, email=?, phone=?, role=?, is_active=?, password_hash=?, pin_code_hash=?,
      token_version = token_version + ?, updated_at=datetime('now')
    WHERE id=?
  `).run(finalName, finalEmail, finalPhone, finalRole, isActive, passwordHash, pinHash, revokesToken ? 1 : 0, id);
  if (revokesToken) authTokens.revokeAllForUser(id);

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

  const tempPassword = crypto.randomBytes(6).toString('base64url'); // e.g. "kQ3f9RtZ"
  const passwordHash = bcrypt.hashSync(tempPassword, 10);
  db.prepare(`UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?`).run(passwordHash, id);
  authTokens.revokeAllForUser(id);

  logStaffAction({ staffId, action: 'update', entityType: 'staff', entityId: existing.id, before: {}, after: { password_reset: true } });
  return { id: existing.id, temporaryPassword: tempPassword };
}

module.exports = { safe, list, getById, create, update, remove, resetPassword };
