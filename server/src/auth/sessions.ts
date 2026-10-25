import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import type { Role } from './permissions.js';
import { sessionPolicy, type SessionPolicy } from './settings.js';
import type { AuthUser } from './types.js';

// A session is one sign-in on one device. It carries the rules that stop the till staying signed in forever:
//   active  : normal use
//   locked  : idle longer than the lock time. The server refuses everything except unlocking, signing out and asking who is
//             signed in, so a stolen browser cannot carry on without the password or PIN. The lock screen is only its face.
//   ended   : idle past the sign-out time (unless "remember this device"), past the hard maximum, or signed out elsewhere.
// Access tokens are short and are replaced whenever the refresh token is used. Refresh tokens rotate INSIDE a session and can
// never stretch it past its hard maximum.

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const newToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export const REFRESH_DAYS_DEFAULT = 30;
export const ACCESS_MINUTES_DEFAULT = 15;
/** Two browser tabs can honestly present the same refresh token moments apart. Only a replay after this long is a stolen-token signal. */
export const REUSE_GRACE_SECONDS = 60;
/** After a refresh, the access token it replaces keeps working this long, so requests already in flight do not fail. */
const PREV_ACCESS_GRACE_SECONDS = 60;

export interface SessionRow {
  id: number; user_id: number; remember: boolean; user_agent: string | null; ip: string | null;
  created_at: Date; last_activity_at: Date; reauth_at: Date; expires_at: Date; access_expires_at: Date;
  revoked_at: Date | null; revoked_reason: string | null; idle_seconds: number; reauth_seconds: number; ended: boolean;
}
const SESSION_COLS = `s.id, s.user_id, s.remember, s.user_agent, s.ip, s.created_at, s.last_activity_at, s.reauth_at, s.expires_at, s.access_expires_at,
  s.revoked_at, s.revoked_reason, EXTRACT(EPOCH FROM (now() - s.last_activity_at))::float8 AS idle_seconds,
  EXTRACT(EPOCH FROM (now() - s.reauth_at))::float8 AS reauth_seconds, (s.expires_at <= now()) AS ended`;

export type Standing = { state: 'active' } | { state: 'locked' } | { state: 'ended'; reason: 'idle' | 'max' | 'revoked' };

/** Where a session stands right now. Uses the database's clock (idle_seconds), never the caller's. */
export function evaluate(s: Pick<SessionRow, 'revoked_at' | 'ended' | 'remember' | 'idle_seconds'>, policy: SessionPolicy): Standing {
  if (s.revoked_at) return { state: 'ended', reason: 'revoked' };
  if (s.ended) return { state: 'ended', reason: 'max' };
  if (!s.remember && s.idle_seconds >= policy.idleSignOutMinutes * 60) return { state: 'ended', reason: 'idle' };
  if (s.idle_seconds >= policy.lockMinutes * 60) return { state: 'locked' };
  return { state: 'active' };
}

/** What the browser needs to run its lock screen and its warnings. */
export function clientPolicy(s: SessionRow, policy: SessionPolicy) {
  return {
    id: s.id,
    remember: s.remember,
    lockAfterSeconds: policy.lockMinutes * 60,
    signOutAfterSeconds: s.remember ? null : policy.idleSignOutMinutes * 60,
    expiresAt: s.expires_at,
    reauthMinutes: policy.reauthMinutes,
    lastActivityAt: s.last_activity_at,
    // How long ago the server last saw real use, on the server's own clock, so the browser need not trust its own.
    idleSeconds: Math.max(0, Math.round(s.idle_seconds)),
  };
}

export async function getSession(db: Queryable, id: number): Promise<SessionRow | undefined> {
  const { rows } = await db.query<SessionRow>(`SELECT ${SESSION_COLS} FROM sessions s WHERE s.id = $1`, [id]);
  return rows[0];
}

export interface NewSession { accessToken: string; refreshToken: string; session: SessionRow; policy: SessionPolicy }

export interface SessionOptions { remember?: boolean; ip?: string | null; userAgent?: string | null; accessMinutes?: number; refreshDays?: number; unrememberedHours?: number }

/** Opens a session with its first access and refresh tokens. The raw tokens exist only in the returned value. */
export async function createSession(db: Pool, user: { id: number; role: Role }, opts: SessionOptions = {}): Promise<NewSession> {
  const policy = await sessionPolicy(db, user.role, opts.unrememberedHours);
  const remember = opts.remember === true;
  const hours = remember ? policy.maxHours : Math.min(policy.maxHours, policy.unrememberedMaxHours);
  const accessToken = newToken();
  const refreshToken = newToken(40);
  const session = await withTransaction(db, async (c) => {
    const ins = await c.query<{ id: number }>(
      `INSERT INTO sessions (user_id, token_hash, expires_at, access_expires_at, remember, user_agent, ip)
       VALUES ($1, $2, now() + make_interval(hours => $3), now() + make_interval(mins => $4), $5, $6, $7) RETURNING id`,
      [user.id, sha256(accessToken), hours, opts.accessMinutes ?? ACCESS_MINUTES_DEFAULT, remember, opts.userAgent?.slice(0, 300) ?? null, opts.ip ?? null]);
    const id = ins.rows[0]!.id;
    await issueRefreshToken(c, user.id, id, refreshToken, opts.refreshDays ?? REFRESH_DAYS_DEFAULT);
    return (await getSession(c, id))!;
  });
  return { accessToken, refreshToken, session, policy };
}

async function issueRefreshToken(c: Queryable, userId: number, sessionId: number, raw: string, days: number): Promise<number> {
  const { rows } = await c.query<{ id: number }>(
    `INSERT INTO refresh_tokens (session_id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, LEAST(now() + make_interval(days => $4), (SELECT expires_at FROM sessions WHERE id = $1))) RETURNING id`,
    [sessionId, userId, sha256(raw), days]);
  return rows[0]!.id;
}

// ------------------------------------------------------------------------------------------------ every request

export type AuthResult =
  | { kind: 'ok'; user: AuthUser; standing: 'active' | 'locked'; session: SessionRow; policy: SessionPolicy }
  | { kind: 'invalid' }          // not a token we know, or the account is deactivated
  | { kind: 'token_expired' }    // a real token whose short life is over: refresh and try again
  | { kind: 'ended' };           // the session itself is over: sign in again

interface AuthRow extends SessionRow {
  username: string; display_name: string; role: Role; must_change_password: boolean; email: string | null;
  overrides: Record<string, boolean>; is_current: boolean; access_live: boolean;
}

/**
 * Finds the person and session behind an access token. A session that has gone idle or past its maximum is ended here, so the
 * next look at it agrees. A token replaced moments ago by a refresh still works for a short overlap.
 */
export async function authenticateToken(db: Pool, token: string): Promise<AuthResult> {
  const h = sha256(token);
  const { rows } = await db.query<AuthRow>(
    `SELECT ${SESSION_COLS}, u.username, u.display_name, u.role, u.must_change_password, u.email,
            (s.token_hash = $1) AS is_current,
            CASE WHEN s.token_hash = $1 THEN s.access_expires_at > now() ELSE COALESCE(s.prev_valid_until > now(), false) END AS access_live,
            (SELECT COALESCE(jsonb_object_agg(p.permission, p.granted), '{}'::jsonb) FROM user_permissions p WHERE p.user_id = u.id) AS overrides
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE (s.token_hash = $1 OR s.prev_token_hash = $1) AND u.active`, [h]);
  const r = rows[0];
  if (!r) return { kind: 'invalid' };
  const policy = await sessionPolicy(db, r.role);
  const standing = evaluate(r, policy);
  if (standing.state === 'ended') {
    if (!r.revoked_at) await endSession(db, r.id, standing.reason === 'idle' ? 'idle' : 'expired');
    return { kind: 'ended' };
  }
  if (!r.access_live) return { kind: 'token_expired' };
  return {
    kind: 'ok', standing: standing.state, session: r, policy,
    user: { id: r.user_id, username: r.username, displayName: r.display_name, role: r.role, mustChangePassword: r.must_change_password, sessionId: r.id, email: r.email, overrides: r.overrides ?? {}, reauthSeconds: r.reauth_seconds },
  };
}

/** Real use of the app: push the idle clock back to zero. At most every 15 seconds, so the disk is not hit for every click. */
export async function touch(db: Queryable, sessionId: number): Promise<void> {
  await db.query(`UPDATE sessions SET last_activity_at = now() WHERE id = $1 AND revoked_at IS NULL AND last_activity_at < now() - interval '15 seconds'`, [sessionId]);
}

/** The password or PIN was just typed correctly: unlocks, and counts as "recently confirmed" for risky actions. */
export async function confirmSession(db: Queryable, sessionId: number): Promise<void> {
  await db.query(`UPDATE sessions SET last_activity_at = now(), reauth_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
}

export const recentlyConfirmed = (user: Pick<AuthUser, "reauthSeconds">, policy: SessionPolicy): boolean => (user.reauthSeconds ?? Infinity) < policy.reauthMinutes * 60;

// ------------------------------------------------------------------------------------------------ ending sessions

export async function endSession(db: Queryable, sessionId: number, reason: string): Promise<void> {
  await db.query(`UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [sessionId, reason]);
  await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE session_id = $1 AND revoked_at IS NULL`, [sessionId]);
}

/** Signs a person out of every device, optionally keeping one. Returns how many sessions ended. */
export async function endAllSessions(db: Queryable, userId: number, opts: { exceptSessionId?: number; reason?: string } = {}): Promise<number> {
  const except = opts.exceptSessionId ?? 0;
  const { rows } = await db.query<{ id: number }>(
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $3 WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2 RETURNING id`, [userId, except, opts.reason ?? 'signed_out_everywhere']);
  await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND session_id <> $2`, [userId, except]);
  return rows.length;
}

// ------------------------------------------------------------------------------------------------ refresh

const REFRESH_INVALID = () => new HttpError(401, 'REFRESH_INVALID', 'Invalid or expired refresh token.');

export interface Refreshed { accessToken: string; refreshToken: string; session: SessionRow; policy: SessionPolicy; user: { id: number; role: Role } }

/**
 * Swaps a refresh token for a new access token and a new refresh token inside the same session. Anything wrong with the
 * token is one answer, without saying which part. A token that was already swapped and comes back after the grace period
 * ends the whole session: someone kept a copy. A locked session may still refresh; the new access token is useless until
 * the password or PIN unlocks it.
 */
export async function refreshSession(db: Pool, raw: string | undefined, opts: { accessMinutes?: number; refreshDays?: number; unrememberedHours?: number; onReuse?: (userId: number) => Promise<void> } = {}): Promise<Refreshed> {
  if (!raw) throw new HttpError(401, 'REFRESH_REQUIRED', 'Refresh token required.');
  const outcome = await withTransaction(db, async (c): Promise<{ ok: Refreshed } | { error: HttpError; reusedFor?: number }> => {
    const found = await c.query<{ id: number; user_id: number; session_id: number; revoked: boolean; replaced_by_id: number | null; live: boolean; since_revoked: number | null }>(
      `SELECT id, user_id, session_id, (revoked_at IS NOT NULL) AS revoked, replaced_by_id, (expires_at > now()) AS live,
              EXTRACT(EPOCH FROM (now() - revoked_at))::float8 AS since_revoked
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`, [sha256(raw)]);
    const t = found.rows[0];
    if (!t) return { error: REFRESH_INVALID() };
    if (t.revoked) {
      if (t.replaced_by_id !== null && (t.since_revoked ?? 0) > REUSE_GRACE_SECONDS) {
        const s = await getSession(c, t.session_id);
        if (s && !s.revoked_at) { await endSession(c, s.id, 'token_reuse'); return { error: REFRESH_INVALID(), reusedFor: t.user_id }; }
      }
      return { error: REFRESH_INVALID() };
    }
    if (!t.live) return { error: REFRESH_INVALID() };
    const u = await c.query<{ id: number; role: Role }>(`SELECT id, role FROM users WHERE id = $1 AND active`, [t.user_id]);
    const user = u.rows[0];
    if (!user) return { error: REFRESH_INVALID() };
    const session = await getSession(c, t.session_id);
    if (!session) return { error: REFRESH_INVALID() };
    const policy = await sessionPolicy(db, user.role, opts.unrememberedHours);
    const standing = evaluate(session, policy);
    if (standing.state === 'ended') {
      if (!session.revoked_at) await endSession(c, session.id, standing.reason === 'idle' ? 'idle' : 'expired');
      return { error: new HttpError(401, 'SESSION_EXPIRED', 'Your session has ended. Please sign in again.') };
    }
    const accessToken = newToken();
    const refreshToken = newToken(40);
    const newId = await issueRefreshToken(c, user.id, session.id, refreshToken, opts.refreshDays ?? REFRESH_DAYS_DEFAULT);
    await c.query(`UPDATE refresh_tokens SET revoked_at = now(), replaced_by_id = $2 WHERE id = $1`, [t.id, newId]);
    await c.query(
      `UPDATE sessions SET prev_token_hash = token_hash, prev_valid_until = now() + make_interval(secs => $3), token_hash = $2,
              access_expires_at = now() + make_interval(mins => $4) WHERE id = $1`,
      [session.id, sha256(accessToken), PREV_ACCESS_GRACE_SECONDS, opts.accessMinutes ?? ACCESS_MINUTES_DEFAULT]);
    return { ok: { accessToken, refreshToken, session: (await getSession(c, session.id))!, policy, user } };
  });
  if ('error' in outcome) {
    if (outcome.reusedFor !== undefined) await opts.onReuse?.(outcome.reusedFor);
    throw outcome.error;
  }
  return outcome.ok;
}

/** Sign-out by refresh token. Never fails: logging out of something already gone is not an error. */
export async function endSessionByRefresh(db: Queryable, raw: string | undefined): Promise<void> {
  if (!raw) return;
  const { rows } = await db.query<{ session_id: number }>(`SELECT session_id FROM refresh_tokens WHERE token_hash = $1`, [sha256(raw)]);
  if (rows[0]) await endSession(db, rows[0].session_id, 'signed_out');
}

// ------------------------------------------------------------------------------------------------ the "signed-in devices" list

export function deviceLabel(ua: string | null): string {
  const s = ua ?? '';
  if (!s) return 'Unknown device';
  const os = /Android/i.test(s) ? 'Android' : /iPhone|iPad|iOS/i.test(s) ? 'iPhone/iPad' : /Windows/i.test(s) ? 'Windows' : /Mac OS X|Macintosh/i.test(s) ? 'Mac' : /CrOS/i.test(s) ? 'Chromebook' : /Linux/i.test(s) ? 'Linux' : null;
  const browser = /SamsungBrowser/i.test(s) ? 'Samsung Internet' : /Edg\//i.test(s) ? 'Edge' : /OPR\/|Opera/i.test(s) ? 'Opera' : /Firefox|FxiOS/i.test(s) ? 'Firefox' : /Chrome|CriOS/i.test(s) ? 'Chrome' : /Safari/i.test(s) ? 'Safari' : 'Browser';
  return os ? `${browser} on ${os}` : browser;
}

/** Live sessions for one person: what the "signed-in devices" screen shows. */
export async function listSessions(db: Pool, user: { id: number; role: Role }, currentSessionId: number | null) {
  const { rows } = await db.query<SessionRow>(`SELECT ${SESSION_COLS} FROM sessions s WHERE s.user_id = $1 AND s.revoked_at IS NULL ORDER BY s.last_activity_at DESC`, [user.id]);
  const policy = await sessionPolicy(db, user.role);
  return rows.flatMap((r) => {
    const st = evaluate(r, policy);
    if (st.state === 'ended') return [];
    return [{ id: r.id, current: r.id === currentSessionId, device: deviceLabel(r.user_agent), ip: r.ip, remember: r.remember, state: st.state,
      signedInAt: r.created_at, lastActiveAt: r.last_activity_at, expiresAt: r.expires_at }];
  });
}
