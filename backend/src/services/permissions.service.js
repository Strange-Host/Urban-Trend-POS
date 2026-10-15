const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const { PERMISSIONS, defaultAllows } = require('../config/permissions');
const { logStaffAction } = require('../utils/auditLog');

function overridesFor(userId) {
  const rows = db.prepare('SELECT permission, granted FROM user_permissions WHERE user_id = ?').all(userId);
  return Object.fromEntries(rows.map((r) => [r.permission, r.granted === 1]));
}

// Admin: always everything. Everyone else: an explicit override wins, else the role default.
function can(user, key, preloadedOverrides) {
  if (!PERMISSIONS[key]) return false; // unknown key = deny, never a silent allow
  if (user.role === 'admin') return true;
  const overrides = preloadedOverrides || overridesFor(user.id);
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  return defaultAllows(user.role, key);
}

function effectiveKeys(user) {
  const overrides = overridesFor(user.id);
  return Object.keys(PERMISSIONS).filter((key) => can(user, key, overrides));
}

// What the admin's editor shows: every key with its group, the role default,
// any explicit override, and the resulting effective value.
function describeForUser({ storeId, userId }) {
  const user = db.prepare('SELECT id, name, role FROM users WHERE id = ? AND store_id = ?').get(userId, storeId);
  if (!user) throw new ApiError(404, 'User not found.');
  const overrides = overridesFor(userId);
  return {
    user,
    locked: user.role === 'admin', // admins can't be restricted
    permissions: Object.entries(PERMISSIONS).map(([key, p]) => ({
      key, group: p.group, label: p.label,
      role_default: defaultAllows(user.role, key),
      override: Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : null,
      effective: can(user, key, overrides),
    })),
  };
}

/**
 * overrides: { [key]: true | false | null } — true/false sets an explicit
 * grant/revoke, null removes the override (back to the role default). An
 * override that merely restates the default is stored as "no override", so
 * changing a role's defaults later still reaches everyone who was never
 * individually customised.
 */
function setOverrides({ storeId, actorId, userId, overrides }) {
  const user = db.prepare('SELECT id, role FROM users WHERE id = ? AND store_id = ?').get(userId, storeId);
  if (!user) throw new ApiError(404, 'User not found.');
  if (user.role === 'admin') throw new ApiError(400, 'Admins always have every permission and cannot be restricted.');
  if (user.id === actorId) throw new ApiError(400, 'You cannot change your own permissions.');

  for (const key of Object.keys(overrides)) {
    if (!PERMISSIONS[key]) throw new ApiError(400, `Unknown permission "${key}".`);
  }

  const before = overridesFor(userId);
  const apply = db.transaction(() => {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null || value === defaultAllows(user.role, key)) {
        db.prepare('DELETE FROM user_permissions WHERE user_id = ? AND permission = ?').run(userId, key);
      } else {
        db.prepare(`
          INSERT INTO user_permissions (user_id, permission, granted, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(user_id, permission) DO UPDATE SET granted = excluded.granted, updated_by = excluded.updated_by, updated_at = excluded.updated_at
        `).run(userId, key, value ? 1 : 0, actorId);
      }
    }
  });
  apply();
  logStaffAction({ staffId: actorId, action: 'update', entityType: 'user_permissions', entityId: userId, before, after: overridesFor(userId) });
  return describeForUser({ storeId, userId });
}

module.exports = { can, effectiveKeys, describeForUser, setOverrides, overridesFor };
