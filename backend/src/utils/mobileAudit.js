const { logStaffAction } = require('./auditLog');

// The phone's identity for the audit trail: the id of its sign-in session, or null when the request did not come from a
// phone (the same endpoints can be called with a web sign-in).
function deviceIdOf(req) {
  return req.session && req.session.client === 'mobile' ? req.session.id : null;
}

// Every write from the phone leaves a staff_logs row that says WHO (staff_id), WHICH PHONE (deviceId), WHY (reason) and
// WHAT changed. staff_logs has no reason or device columns, so both travel inside the change record.
function auditV1(req, { action, entityType, entityId, before = null, after = {}, reason = null }) {
  const extra = { ...(reason ? { reason } : {}), ...(deviceIdOf(req) ? { deviceId: deviceIdOf(req) } : {}) };
  logStaffAction({
    staffId: req.user.id, action, entityType, entityId,
    before: action === 'delete' ? before : before,
    after: { ...after, ...extra },
  });
}

module.exports = { auditV1, deviceIdOf };
