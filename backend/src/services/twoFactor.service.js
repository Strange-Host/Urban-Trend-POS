const crypto = require('crypto');
const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const { toMsisdn } = require('../utils/phone');
const { logStaffAction } = require('../utils/auditLog');
const settingsService = require('./settings.service');
const smsService = require('./sms.service');

// SMS one-time code at login, for accounts where an admin has switched it on.
// Built to avoid the weaknesses of the older system's OTP: the code comes from
// crypto.randomInt (not java.util.Random), lives in the database with an
// expiry (not an in-memory map that a restart wipes and a second instance
// can't see), is stored only as a keyed HMAC, is NEVER logged, is bound to one
// login attempt by a random token (not keyed by phone number, so two staff
// sharing a number can't collide), and every step is attempt- and rate-limited.
const CODE_TTL_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 3;
const RESEND_COOLDOWN_SECONDS = 30;
const MAX_CHALLENGES_PER_HOUR = 5;

function hmac(token, code) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${token}:${code}`).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function newCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function codeMessage(code) {
  const business = settingsService.getAll().business_name || 'Urban Trends';
  return `${business} sign-in code: ${code}. Valid for ${CODE_TTL_MINUTES} minutes. Never share this code with anyone.`;
}

async function deliver(user, code) {
  const result = await smsService.sendNow({ storeId: user.store_id, to: user.phone, message: codeMessage(code) });
  if (!result.ok) {
    logger.error(`[2fa] could not send a sign-in code to user ${user.id}: ${result.error}`); // no code, no number
    throw new ApiError(503, 'We could not send your verification code. Try again in a minute, or ask an admin for help.', null, 'OTP_SEND_FAILED');
  }
}

/**
 * Password was already verified by the caller. Creates a challenge, texts the
 * code, and returns what the browser needs to continue — never a session.
 */
async function start(user) {
  const recent = db.prepare(`SELECT COUNT(*) AS n FROM otp_challenges WHERE user_id = ? AND created_at >= datetime('now', '-1 hour')`).get(user.id).n;
  if (recent >= MAX_CHALLENGES_PER_HOUR) {
    throw new ApiError(429, 'Too many sign-in attempts. Please wait a while and try again.', null, 'OTP_RATE_LIMITED');
  }

  const token = crypto.randomBytes(24).toString('hex');
  const code = newCode();
  db.prepare(`INSERT INTO otp_challenges (user_id, token, code_hmac, expires_at) VALUES (?, ?, ?, datetime('now', '+' || ? || ' minutes'))`)
    .run(user.id, token, hmac(token, code), CODE_TTL_MINUTES);

  try {
    await deliver(user, code);
  } catch (err) {
    db.prepare('UPDATE otp_challenges SET consumed_at = datetime(\'now\') WHERE token = ?').run(token); // a code nobody received must not stay valid
    throw err;
  }
  return { twoFactorRequired: true, challengeToken: token, phoneHint: smsService.maskPhone(toMsisdn(user.phone)), expiresInSeconds: CODE_TTL_MINUTES * 60 };
}

const GENERIC_FAILURE = () => new ApiError(401, 'That code is invalid or has expired. Sign in again to get a new one.', null, 'OTP_INVALID');

/** Returns the user row on success; throws a deliberately uniform 401 otherwise. */
function verify({ challengeToken, code }) {
  const row = db.prepare('SELECT * FROM otp_challenges WHERE token = ?').get(String(challengeToken || ''));
  if (!row || row.consumed_at) throw GENERIC_FAILURE();
  const expired = db.prepare(`SELECT datetime('now') > ? AS expired`).get(row.expires_at).expired === 1;
  if (expired || row.attempts >= MAX_ATTEMPTS) throw GENERIC_FAILURE();

  // Count the attempt BEFORE comparing, so concurrent guesses can't slip past the cap.
  db.prepare('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?').run(row.id);

  if (!safeEqual(hmac(row.token, String(code || '').trim()), row.code_hmac)) throw GENERIC_FAILURE();

  const consumed = db.prepare(`UPDATE otp_challenges SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL`).run(row.id);
  if (consumed.changes !== 1) throw GENERIC_FAILURE(); // a parallel request already used it

  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(row.user_id);
  if (!user) throw GENERIC_FAILURE();
  return user;
}

async function resend({ challengeToken }) {
  const row = db.prepare('SELECT * FROM otp_challenges WHERE token = ?').get(String(challengeToken || ''));
  if (!row || row.consumed_at) throw GENERIC_FAILURE();
  const expired = db.prepare(`SELECT datetime('now') > ? AS expired`).get(row.expires_at).expired === 1;
  if (expired) throw GENERIC_FAILURE();
  if (row.resend_count >= MAX_RESENDS) throw new ApiError(429, 'No more resends for this sign-in. Start again.', null, 'OTP_RATE_LIMITED');
  const waited = db.prepare(`SELECT (julianday('now') - julianday(?)) * 86400 AS s`).get(row.sent_at).s;
  if (waited < RESEND_COOLDOWN_SECONDS) {
    throw new ApiError(429, `Please wait ${Math.ceil(RESEND_COOLDOWN_SECONDS - waited)} seconds before asking for another code.`, null, 'OTP_RATE_LIMITED');
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(row.user_id);
  if (!user) throw GENERIC_FAILURE();
  const code = newCode();
  db.prepare(`
    UPDATE otp_challenges SET code_hmac = ?, attempts = 0, resend_count = resend_count + 1, sent_at = datetime('now'),
      expires_at = datetime('now', '+' || ? || ' minutes') WHERE id = ?
  `).run(hmac(row.token, code), CODE_TTL_MINUTES, row.id);
  await deliver(user, code);
  return { sent: true, expiresInSeconds: CODE_TTL_MINUTES * 60 };
}

/**
 * Admin turns 2FA on/off for an account. Enabling is refused unless the code
 * can actually be delivered — otherwise you would lock someone out of an
 * account they can no longer sign in to. (Break-glass if SMS ever fails:
 * `npm run disable-2fa -- <email>` on the server.)
 */
function setEnabled({ storeId, actorId, userId, enabled }) {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND store_id = ?').get(userId, storeId);
  if (!user) throw new ApiError(404, 'User not found.');

  if (enabled) {
    if (!toMsisdn(user.phone)) throw new ApiError(400, 'This account needs a valid Kenyan mobile number before sign-in codes can be turned on.');
    if (!smsService.getRawCredentials(storeId)) throw new ApiError(400, 'Save your Zettatel SMS credentials (Settings → Customer SMS) before turning on sign-in codes.');
  }

  db.prepare(`UPDATE users SET two_factor_enabled = ?, token_version = token_version + 1, updated_at = datetime('now') WHERE id = ?`).run(enabled ? 1 : 0, userId);
  logStaffAction({ staffId: actorId, action: 'update', entityType: 'staff', entityId: userId, before: { two_factor_enabled: user.two_factor_enabled }, after: { two_factor_enabled: enabled ? 1 : 0 } });
  return { id: userId, two_factor_enabled: enabled ? 1 : 0 };
}

module.exports = { start, verify, resend, setEnabled, CODE_TTL_MINUTES, MAX_ATTEMPTS };
