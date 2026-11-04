const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const logger = require('../utils/logger');
const { offsetMinutes } = require('../utils/storeTime');

// Push notifications to the mobile app, through Firebase Cloud Messaging (the HTTP v1 API).
//
// How it fits in: notifications.service.notify() already writes the in-app notification (the "bell") for each recipient and
// stays the source of truth - so nothing is lost if a push fails or the phone is offline. After it has written them it
// calls pushForNotification() here, which decides whether the notification deserves a push, finds the recipients' live
// phones (devices.service.pushTokensForUsers) and sends. A push is a nudge to open the app, not a second copy of the data.
//
// Rules:
//  - Only things that need a decision (see shouldPush) - a phone that buzzes for everything gets muted.
//  - Never throws and never blocks: a Firebase problem must not break the sale / approval that caused the notification.
//  - Off until the server has a Firebase service account (FCM_SERVICE_ACCOUNT_FILE, or FCM_SERVICE_ACCOUNT_JSON). With none
//    configured everything here is a quiet no-op, so the backend runs and tests fine before Firebase is set up.
//  - A token Google says is dead (app uninstalled, token rotated) is wiped, so we stop trying it.

// ---- what deserves a push --------------------------------------------------------------------------------------------
// Notification types that mean "someone is waiting on you to decide". Informational ones (an approval was decided, low
// stock, a lead was assigned...) stay in the bell only.
const DECISION_TYPES = new Set([
  'approval_requested',
  'expense_pending',
  'petty_cash_topup_pending',
  'stock_transfer_pending',
  'product_proposed',
  // The spec's other push triggers (see notifications.service sweeps and cashSessions.close):
  'unmatched_payment_stale',        // an incoming payment that matched no order for over an hour
  'courier_remittance_overdue',     // a courier organization holding customer money past its limit
  'cash_variance',                  // a till closed short or over by more than the owner's threshold
]);

/**
 * Should this notification also be pushed? Decisions always; anything urgent (a damaged return, a locked account, a replayed
 * sign-in); and security alerts at warning level or above (a new phone signing in, a big refund or void, a price dropped).
 */
function shouldPush({ type, severity }) {
  if (DECISION_TYPES.has(type)) return true;
  if (severity === 'urgent') return true;
  return type === 'security' && severity === 'warning';
}

// ---- providers -------------------------------------------------------------------------------------------------------
// A provider is { name, send({ token, title, body, data }) -> { ok, invalidToken?, error? } }. FCM is the real one; tests
// plug in a fake with setProvider().

let override = null;
const setProvider = (p) => { override = p; };

function loadServiceAccount() {
  try {
    const raw = process.env.FCM_SERVICE_ACCOUNT_JSON
      || (process.env.FCM_SERVICE_ACCOUNT_FILE ? fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT_FILE, 'utf8') : null);
    if (!raw) return null;
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error('missing client_email, private_key or project_id');
    return sa;
  } catch (err) {
    logger.error(`[push] the Firebase service account could not be read, so pushes are off: ${err.message}`);   // never log the key itself
    return null;
  }
}

function fcmProvider(sa) {
  let access = null;   // { token, expiresAt }
  const TOKEN_URL = sa.token_uri || 'https://oauth2.googleapis.com/token';

  async function accessToken() {
    if (access && access.expiresAt - Date.now() > 60_000) return access.token;
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: TOKEN_URL, iat: now, exp: now + 3600 },
      sa.private_key, { algorithm: 'RS256' },
    );
    const r = await axios.post(TOKEN_URL, new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 });
    access = { token: r.data.access_token, expiresAt: Date.now() + (Number(r.data.expires_in) || 3600) * 1000 };
    return access.token;
  }

  return {
    name: 'fcm',
    async send({ token, title, body, data }) {
      try {
        const bearer = await accessToken();
        await axios.post(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
          message: {
            token,
            notification: { title, body: body || undefined },
            data,                                                   // FCM requires every value to be a string
            android: { priority: 'HIGH', notification: { channel_id: 'decisions' } },
          },
        }, { headers: { Authorization: `Bearer ${bearer}` }, timeout: 10_000 });
        return { ok: true };
      } catch (err) {
        const status = err.response?.status;
        const fcmCode = err.response?.data?.error?.details?.find?.((d) => d.errorCode)?.errorCode || err.response?.data?.error?.status;
        // A token Google no longer knows. (INVALID_ARGUMENT can also mean our own message was malformed, so it only counts
        // when Google names the token.)
        const invalidToken = status === 404 || fcmCode === 'UNREGISTERED'
          || (fcmCode === 'INVALID_ARGUMENT' && /registration token|token/i.test(err.response?.data?.error?.message || ''));
        if (status === 401) access = null;                         // the cached access token went stale: fetch a fresh one next time
        return { ok: false, invalidToken, error: `${status || err.code || 'error'} ${fcmCode || err.message}`.slice(0, 200) };
      }
    },
  };
}

let cached = null;   // { provider } | { none: true }
function getProvider() {
  if (override) return override;
  if (!cached) {
    const sa = loadServiceAccount();
    cached = sa ? { provider: fcmProvider(sa) } : { none: true };
  }
  return cached.provider || null;
}
const isConfigured = () => Boolean(getProvider());
const resetForTests = () => { cached = null; override = null; };

// ---- quiet hours ------------------------------------------------------------------------------------------------------
// A person can switch pushes off for part of the day (users.quiet_start / quiet_end, 'HH:MM' on the shop's clock, and the
// window may cross midnight: 22:00 -> 06:00). Their bell still fills; only the buzz on the phone is held back. An 'urgent'
// notification (a replayed sign-in, a locked account, a damaged return) ignores quiet hours: those are the ones nobody
// wants to sleep through.
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function inQuietHours(user, now = new Date()) {
  if (!user || !user.quiet_start || !user.quiet_end) return false;
  const local = (((now.getUTCHours() * 60 + now.getUTCMinutes() + offsetMinutes(now)) % 1440) + 1440) % 1440;
  const start = minutesOf(user.quiet_start);
  const end = minutesOf(user.quiet_end);
  if (start === end) return false;
  return start < end ? local >= start && local < end : local >= start || local < end;
}

/** The subset of userIds that may be buzzed right now. */
function awakeUserIds(userIds, now = new Date()) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, quiet_start, quiet_end FROM users WHERE id IN (${marks})`).all(...ids);
  return rows.filter((u) => !inQuietHours(u, now)).map((u) => u.id);
}

// ---- sending ----------------------------------------------------------------------------------------------------------

const clean = (s, max) => (s == null ? undefined : String(s).slice(0, max));

/** Wipe a token Google says is dead, on whichever session holds it. */
function forgetToken(token) {
  db.prepare('UPDATE auth_sessions SET push_token = NULL, push_token_updated_at = NULL WHERE push_token = ?').run(token);
}

/**
 * Sends one push to every live phone of these users. Never throws. Returns { sent, failed, removed, skipped }.
 * `data` is what the app needs to open the right screen; everything in it is sent as a string.
 */
async function sendToUsers({ userIds, title, body = null, data = {}, severity = 'info' }) {
  const result = { sent: 0, failed: 0, removed: 0, skipped: null };
  try {
    const provider = getProvider();
    if (!provider) { result.skipped = 'not_configured'; return result; }
    if (severity !== 'urgent') {
      const awake = awakeUserIds(userIds);
      if (!awake.length) { result.skipped = 'quiet_hours'; return result; }
      userIds = awake;
    }
    const devices = require('./devices.service');      // loaded here: devices -> securityAlerts -> notifications -> push would otherwise be a cycle
    const targets = devices.pushTokensForUsers(userIds);
    if (!targets.length) { result.skipped = 'no_devices'; return result; }

    const payload = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
    for (let i = 0; i < targets.length; i += 10) {        // ten at a time: fast enough, gentle on the connection
      await Promise.all(targets.slice(i, i + 10).map(async (t) => {
        const r = await provider.send({ token: t.token, title: clean(title, 120), body: clean(body, 240), data: payload });
        if (r.ok) { result.sent += 1; return; }
        result.failed += 1;
        if (r.invalidToken) { forgetToken(t.token); result.removed += 1; }
        else logger.warn(`[push] a push to device ${t.deviceId} failed: ${r.error}`);   // never the token
      }));
    }
  } catch (err) {
    logger.error(`[push] could not send: ${err.message}`);
  }
  return result;
}

/**
 * Called by notifications.notify() once it has written the bell rows. `userIds` is only the people who actually got a NEW
 * notification (a repeat that was de-duplicated is not pushed again). Fire-and-forget by design.
 */
function pushForNotification({ userIds, type, severity, title, body, entityType, entityId }) {
  if (!userIds?.length || !shouldPush({ type, severity })) return null;
  if (!isConfigured()) return null;
  return sendToUsers({
    userIds, title, body, severity,
    data: { kind: type, severity, entityType, entityId, link: entityType && entityId ? `${entityType}:${entityId}` : undefined, id: crypto.randomUUID() },
  }).catch(() => null);
}

module.exports = { shouldPush, DECISION_TYPES, inQuietHours, awakeUserIds, sendToUsers, pushForNotification, isConfigured, setProvider, resetForTests };
