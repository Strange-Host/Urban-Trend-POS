const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const settingsService = require('../services/settings.service');
const sessionsService = require('../services/sessions.service');
const securityAlerts = require('../services/securityAlerts.service');

const ROLES = ['cashier', 'manager', 'admin'];

function currentPolicy() {
  const s = settingsService.getAll();
  const n = (k) => Number(s[k]);
  return {
    lockout: { attempts: n('security_lockout_attempts'), minutes: n('security_lockout_minutes') },
    roles: Object.fromEntries(ROLES.map((r) => [r, {
      lockMinutes: n(`security_lock_minutes_${r}`),
      idleSignOutMinutes: n(`security_idle_signout_minutes_${r}`),
      maxHours: n(`security_max_session_hours_${r}`),
    }])),
    unrememberedMaxHours: n('security_unremembered_max_hours'),
    reauthMinutes: n('security_reauth_minutes'),
    alerts: { refundKes: n('security_alert_refund_kes'), stockUnits: n('security_alert_stock_units'), pricePercent: n('security_alert_price_percent') },
  };
}

function whole(v, label, min, max) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError(400, `${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

// GET /api/security/policy
const getPolicy = asyncHandler(async (req, res) => {
  res.json({ data: currentPolicy() });
});

// PUT /api/security/policy - the whole policy (or any part of it); validated here, never through the generic settings route
const updatePolicy = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const cur = currentPolicy();
  const next = {
    lockout: { ...cur.lockout, ...(body.lockout || {}) },
    roles: Object.fromEntries(ROLES.map((r) => [r, { ...cur.roles[r], ...((body.roles || {})[r] || {}) }])),
    unrememberedMaxHours: body.unrememberedMaxHours ?? cur.unrememberedMaxHours,
    reauthMinutes: body.reauthMinutes ?? cur.reauthMinutes,
    alerts: { ...cur.alerts, ...(body.alerts || {}) },
  };

  const updates = {
    security_lockout_attempts: whole(next.lockout.attempts, 'Wrong attempts before locking', 3, 20),
    security_lockout_minutes: whole(next.lockout.minutes, 'Lock time (minutes)', 1, 1440),
    security_unremembered_max_hours: whole(next.unrememberedMaxHours, 'Longest sign-in without "remember this device" (hours)', 1, 720),
    security_reauth_minutes: whole(next.reauthMinutes, 'Password re-check window (minutes)', 1, 60),
    security_alert_refund_kes: whole(next.alerts.refundKes, 'Refund alert amount (KES)', 0, 100000000),
    security_alert_stock_units: whole(next.alerts.stockUnits, 'Stock adjustment alert (units)', 1, 1000000),
    security_alert_price_percent: whole(next.alerts.pricePercent, 'Price change alert (%)', 1, 100),
  };
  for (const r of ROLES) {
    const p = next.roles[r];
    const lock = whole(p.lockMinutes, `${r}: lock screen after (minutes)`, 1, 240);
    const idle = whole(p.idleSignOutMinutes, `${r}: sign out after (minutes)`, 2, 10080);
    const max = whole(p.maxHours, `${r}: longest sign-in (hours)`, 1, 720);
    if (idle <= lock) throw new ApiError(400, `${r}: signing out must come after the screen locks (sign-out minutes must be more than lock minutes).`);
    updates[`security_lock_minutes_${r}`] = lock;
    updates[`security_idle_signout_minutes_${r}`] = idle;
    updates[`security_max_session_hours_${r}`] = max;
  }

  settingsService.setMany(Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, String(v)])), req.user.id);
  sessionsService.clearCache();
  securityAlerts.raise({
    storeId: req.user.storeId, type: 'policy_changed', severity: 'info', actorId: req.user.id,
    title: `Security settings changed by ${req.user.name}`, detail: 'Lock, sign-out, lockout or alert limits were updated.',
  });
  res.json({ data: currentPolicy() });
});

// GET /api/security/events?limit=50 - latest lockouts, resets, erasures, large refunds...
const listEvents = asyncHandler(async (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const rows = db.prepare(`
    SELECT e.id, e.type, e.severity, e.title, e.detail, e.ip, e.created_at,
           a.name AS actor_name, s.name AS subject_name
    FROM security_events e
    LEFT JOIN users a ON a.id = e.actor_id
    LEFT JOIN users s ON s.id = e.subject_id
    WHERE e.store_id = ? OR e.store_id IS NULL
    ORDER BY e.id DESC LIMIT ?
  `).all(req.user.storeId, limit);
  res.json({ data: rows });
});

module.exports = { getPolicy, updatePolicy, listEvents, currentPolicy };
