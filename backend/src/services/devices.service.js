const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const sessions = require('./sessions.service');
const securityAlerts = require('./securityAlerts.service');
const { logStaffAction } = require('../utils/auditLog');

// A "device" is one install of the mobile app signed in as one person: an auth_sessions row with client = 'mobile'.
// Reusing the session row (instead of a parallel table) is what makes revoking work with no extra checks: the access
// token names its session, middleware/auth.js refuses a revoked session on the very next request, and
// sessions.revoke() kills the session's refresh tokens in the same step.

const clean = (v, max) => {
  const s = v == null ? '' : String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** Normalises what the app sends about itself into what sessions.create() stores. */
function describe(device = {}) {
  return {
    id: clean(device.deviceId, 100),
    name: clean(device.name, 80),
    platform: clean(device.platform, 40),
    appVersion: clean(device.appVersion, 40),
  };
}

/** Has this person signed in on this install before? (Called BEFORE the new session is created.) */
function isKnownDevice(userId, deviceId) {
  if (!deviceId) return true;                          // an install that does not identify itself can't be recognised, so no alert
  return Boolean(db.prepare('SELECT 1 FROM auth_sessions WHERE user_id = ? AND device_id = ? LIMIT 1').get(userId, deviceId));
}

/** Tells the admins that someone signed in from a phone they have not used before. Never throws. */
function alertNewDevice({ user, device, ip }) {
  return securityAlerts.raise({
    // 'warning' so it is also pushed to the admins' phones (push.service shouldPush): the spec lists a new device login as a push trigger.
    storeId: user.store_id, type: 'new_device_login', severity: 'warning', actorId: user.id, subjectId: user.id, ip,
    title: `${user.name} signed in on a new phone`,
    detail: `${device.name || 'An unnamed device'}${device.platform ? ` (${device.platform})` : ''}${device.appVersion ? `, app ${device.appVersion}` : ''}. If this was not ${user.name}, revoke the device under Staff, then change their password.`,
  });
}

/**
 * Stores an FCM registration token on a session. A token belongs to exactly one live session: if the same phone was
 * signed in as someone else before (a shared phone, or a reinstall), the older owner stops receiving pushes on it.
 * Pass null/'' to clear it (the user switched notifications off).
 */
function setPushToken(sessionId, token) {
  const value = clean(token, 4096);
  db.transaction(() => {
    if (value) db.prepare('UPDATE auth_sessions SET push_token = NULL WHERE push_token = ? AND id != ?').run(value, sessionId);
    db.prepare('UPDATE auth_sessions SET push_token = ?, push_token_updated_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(value, value ? new Date().toISOString() : null, sessionId);
  })();
}

/** POST /devices - the app reports who it is (and optionally a push token) for the session it is signed in with. */
function register(session, input) {
  if (session.client !== 'mobile') throw new ApiError(403, 'Only the mobile app can register a device.', null, 'MOBILE_ONLY');
  const d = describe(input);
  db.prepare(`
    UPDATE auth_sessions SET device_id = COALESCE(?, device_id), device_name = COALESCE(?, device_name),
      platform = COALESCE(?, platform), app_version = COALESCE(?, app_version)
    WHERE id = ?
  `).run(d.id, d.name, d.platform, d.appVersion, session.id);
  if (Object.prototype.hasOwnProperty.call(input, 'pushToken')) setPushToken(session.id, input.pushToken);
  return toPublic(sessions.get(session.id), session.id);
}

function toPublic(row, currentSessionId) {
  return {
    id: row.id, name: row.device_name || 'Unnamed device', platform: row.platform, appVersion: row.app_version,
    current: row.id === currentSessionId, pushEnabled: Boolean(row.push_token),
    signedInAt: row.created_at, lastSeenAt: row.last_activity_at, expiresAt: row.absolute_expires_at,
    ...(row.owner_name ? { user: { id: row.user_id, name: row.owner_name } } : {}),
  };
}

/** Live phones for one person, newest activity first. */
function listForUser(userId, currentSessionId = null) {
  const rows = db.prepare(`
    SELECT s.*, u.name AS owner_name, u.role AS owner_role FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ? AND s.client = 'mobile' AND s.revoked_at IS NULL ORDER BY s.last_activity_at DESC
  `).all(userId);
  return rows
    .filter((r) => sessions.evaluate(r, r.owner_role).state === 'active')
    .map((r) => toPublic(r, currentSessionId));
}

/** Every live phone in the business (the owner's "all devices" screen). */
function listAll(currentSessionId = null) {
  const rows = db.prepare(`
    SELECT s.*, u.name AS owner_name, u.role AS owner_role FROM auth_sessions s JOIN users u ON u.id = s.user_id
    WHERE s.client = 'mobile' AND s.revoked_at IS NULL ORDER BY s.last_activity_at DESC
  `).all();
  return rows
    .filter((r) => sessions.evaluate(r, r.owner_role).state === 'active')
    .map((r) => toPublic(r, currentSessionId));
}

/**
 * Signs a phone out. People may revoke their own phones; an admin may revoke anyone's. Unknown id, someone else's
 * phone and a web session all answer the same 404, so ids can't be probed.
 */
function revoke(deviceId, actor) {
  const target = sessions.get(Number(deviceId));
  const allowed = target && target.client === 'mobile' && (target.user_id === actor.id || actor.role === 'admin');
  if (!allowed) throw new ApiError(404, 'Device not found.');
  if (target.revoked_at) return { ok: true, alreadyRevoked: true };
  sessions.revoke(target.id, target.user_id === actor.id ? 'device_signed_out' : 'device_revoked');
  logStaffAction({
    staffId: actor.id, action: 'update', entityType: 'device_session', entityId: target.id,
    before: { revoked: false, device: target.device_name, userId: target.user_id }, after: { revoked: true, device: target.device_name, userId: target.user_id },
  });
  return { ok: true, alreadyRevoked: false };
}

/**
 * Push fan-out hook: the FCM registration tokens that should receive a push for these users. Only live phones count
 * (a revoked or expired session has no token). The notification service will call this when push delivery is added.
 */
function pushTokensForUsers(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT s.id AS deviceId, s.user_id AS userId, s.push_token AS token FROM auth_sessions s
    WHERE s.client = 'mobile' AND s.revoked_at IS NULL AND s.push_token IS NOT NULL AND s.absolute_expires_at > ? AND s.user_id IN (${marks})
  `).all(new Date().toISOString(), ...ids);
}

module.exports = { describe, isKnownDevice, alertNewDevice, setPushToken, register, listForUser, listAll, revoke, pushTokensForUsers };
