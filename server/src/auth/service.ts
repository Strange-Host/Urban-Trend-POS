import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { audit } from '../pos/audit.js';
import { checkPasswordRules, DUMMY_HASH, hashPassword, temporaryPassword, verifyPassword } from './password.js';
import { ROLES, type Role } from './permissions.js';
import type { AuthUser } from './types.js';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
const BAD_LOGIN = () => new HttpError(401, 'BAD_CREDENTIALS', 'Wrong username or password.');

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const cleanName = (s: unknown) => String(s ?? '').trim().toLowerCase().slice(0, 64) || 'unknown';

export interface UserView {
  id: number; username: string; displayName: string; role: Role; active: boolean;
  mustChangePassword: boolean; lockedUntil: Date | null; lastLoginAt: Date | null; createdAt: Date; createdBy: string;
}
interface UserRow {
  id: number; username: string; display_name: string; role: Role; active: boolean; must_change_password: boolean;
  locked_until: Date | null; last_login_at: Date | null; created_at: Date; created_by: string;
}
const COLS = `id, username, display_name, role, active, must_change_password, locked_until, last_login_at, created_at, created_by`;
const toView = (r: UserRow): UserView => ({
  id: r.id, username: r.username, displayName: r.display_name, role: r.role, active: r.active, mustChangePassword: r.must_change_password,
  lockedUntil: r.locked_until, lastLoginAt: r.last_login_at, createdAt: r.created_at, createdBy: r.created_by,
});

// ------------------------------------------------------------------------------------------------ sessions

export async function revokeSessions(db: Queryable, userId: number, exceptSessionId?: number): Promise<void> {
  await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id <> $2`, [userId, exceptSessionId ?? 0]);
}

/** Finds the person behind a bearer token, or null. Revoked, expired and deactivated all look the same: not logged in. */
export async function authenticateToken(db: Queryable, token: string): Promise<AuthUser | null> {
  const { rows } = await db.query<{ session_id: number; id: number; username: string; display_name: string; role: Role; must_change_password: boolean; stale: boolean }>(
    `SELECT s.id AS session_id, u.id, u.username, u.display_name, u.role, u.must_change_password,
            (s.last_seen_at < now() - interval '1 minute') AS stale
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active`, [sha256(token)]);
  const r = rows[0];
  if (!r) return null;
  if (r.stale) await db.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [r.session_id]);
  return { id: r.id, username: r.username, displayName: r.display_name, role: r.role, mustChangePassword: r.must_change_password, sessionId: r.session_id };
}

// ------------------------------------------------------------------------------------------------ login / logout

interface CredentialRow extends UserRow { password_hash: string; failed_attempts: number }

/**
 * Checks a username and password with the same protections as logging in: one answer for "no such user" and "wrong password",
 * the same cost either way, lockout after repeated failures, and an audit row for every miss. Returns the person on success.
 */
export async function verifyCredentials(pool: Pool, username: string, password: string): Promise<UserView> {
  const name = cleanName(username);
  const found = await pool.query<CredentialRow>(`SELECT ${COLS}, password_hash, failed_attempts FROM users WHERE username = $1`, [name]);
  const u = found.rows[0];

  if (!u) {
    await verifyPassword(password, DUMMY_HASH); // same cost as a real check, so timing does not reveal which usernames exist
    await audit(pool, { actor: name, action: 'login_failed', entityType: 'user', risk: 1, details: { reason: 'unknown_user' } });
    throw BAD_LOGIN();
  }
  if (u.locked_until && u.locked_until > new Date()) {
    await audit(pool, { actor: u.username, role: u.role, action: 'login_blocked', entityType: 'user', entityId: u.id, risk: 1, details: { reason: 'locked' } });
    throw new HttpError(423, 'ACCOUNT_LOCKED', `Too many wrong passwords. Try again in ${LOCK_MINUTES} minutes, or ask an admin to reset it.`);
  }

  const ok = await verifyPassword(password, u.password_hash);
  if (!ok || !u.active) {
    if (!ok) {
      // The counter restarts at zero when it locks, so after the lock ends the person gets a fresh set of tries.
      const upd = await pool.query<{ failed_attempts: number; locked: boolean }>(
        `UPDATE users SET failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
                locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1 RETURNING failed_attempts, (locked_until IS NOT NULL AND locked_until > now()) AS locked`, [u.id, MAX_FAILED_ATTEMPTS, LOCK_MINUTES]);
      const locked = upd.rows[0]?.locked ?? false;
      await audit(pool, { actor: u.username, role: u.role, action: locked ? 'account_locked' : 'login_failed', entityType: 'user', entityId: u.id,
        risk: locked ? 2 : 1, details: { attempts: locked ? MAX_FAILED_ATTEMPTS : upd.rows[0]?.failed_attempts ?? 0 } });
    } else {
      await audit(pool, { actor: u.username, role: u.role, action: 'login_failed', entityType: 'user', entityId: u.id, risk: 1, details: { reason: 'inactive' } });
    }
    throw BAD_LOGIN();
  }
  await pool.query(`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1`, [u.id]);
  return toView(u);
}

export async function login(pool: Pool, input: { username: string; password: string; sessionHours: number }): Promise<{ token: string; expiresAt: Date; user: UserView }> {
  const user = await verifyCredentials(pool, input.username, input.password);
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + input.sessionHours * 3_600_000);
  await withTransaction(pool, async (c) => {
    await c.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    await c.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [user.id, sha256(token), expiresAt]);
    await audit(c, { actor: user.username, role: user.role, action: 'login', entityType: 'user', entityId: user.id });
  });
  return { token, expiresAt, user: { ...user, lastLoginAt: new Date() } };
}

export async function logout(pool: Pool, user: AuthUser): Promise<void> {
  await pool.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [user.sessionId]);
  await audit(pool, { actor: user.username, role: user.role, action: 'logout', entityType: 'user', entityId: user.id });
}

export async function getUser(db: Queryable, id: number): Promise<UserView | null> {
  const { rows } = await db.query<UserRow>(`SELECT ${COLS} FROM users WHERE id = $1`, [id]);
  return rows[0] ? toView(rows[0]) : null;
}

export async function changeOwnPassword(pool: Pool, user: AuthUser, input: { currentPassword: string; newPassword: string }): Promise<void> {
  const { rows } = await pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [user.id]);
  if (!rows[0] || !(await verifyPassword(input.currentPassword, rows[0].password_hash))) {
    await audit(pool, { actor: user.username, role: user.role, action: 'password_change_failed', entityType: 'user', entityId: user.id, risk: 1 });
    throw new HttpError(403, 'WRONG_CURRENT_PASSWORD', 'The current password is not right.');
  }
  if (input.newPassword === input.currentPassword) throw new HttpError(422, 'PASSWORD_UNCHANGED', 'Choose a different password from the current one.');
  checkPasswordRules(input.newPassword, user.username);
  const hash = await hashPassword(input.newPassword);
  await withTransaction(pool, async (c) => {
    await c.query(`UPDATE users SET password_hash = $2, must_change_password = false, failed_attempts = 0, locked_until = NULL WHERE id = $1`, [user.id, hash]);
    await revokeSessions(c, user.id, user.sessionId); // a changed password signs out every other device
    await audit(c, { actor: user.username, role: user.role, action: 'password_changed', entityType: 'user', entityId: user.id, risk: 1 });
  });
}

// ------------------------------------------------------------------------------------------------ user management (admin)

export async function listUsers(db: Queryable): Promise<UserView[]> {
  const { rows } = await db.query<UserRow>(`SELECT ${COLS} FROM users ORDER BY active DESC, username`);
  return rows.map(toView);
}

const isRole = (r: unknown): r is Role => ROLES.includes(r as Role);

/** Creates an account with a one-time password, shown once. The person must change it at first login. */
export async function createUser(pool: Pool, input: { username: string; displayName: string; role: Role; actor: string; actorRole?: Role }): Promise<{ user: UserView; temporaryPassword: string }> {
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(username)) {
    throw new HttpError(422, 'BAD_USERNAME', 'A username is 2 to 32 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.');
  }
  if (!isRole(input.role)) throw new HttpError(422, 'BAD_ROLE', `A role is one of: ${ROLES.join(', ')}.`);
  const temp = temporaryPassword();
  const hash = await hashPassword(temp);
  try {
    return await withTransaction(pool, async (c) => {
      const { rows } = await c.query<UserRow>(
        `INSERT INTO users (username, display_name, role, password_hash, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
        [username, input.displayName.trim(), input.role, hash, input.actor]);
      await audit(c, { actor: input.actor, role: input.actorRole, action: 'user_created', entityType: 'user', entityId: rows[0]!.id, risk: 1, details: { username, role: input.role } });
      return { user: toView(rows[0]!), temporaryPassword: temp };
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'USERNAME_TAKEN', 'That username is already used.');
    throw err;
  }
}

/** Never leaves the shop without an admin: demoting or deactivating the last active admin is refused. */
async function assertAnotherAdminRemains(c: Queryable, exceptUserId: number): Promise<void> {
  const { rows } = await c.query<{ n: string }>(`SELECT count(*) AS n FROM users WHERE role = 'admin' AND active AND id <> $1`, [exceptUserId]);
  if (Number(rows[0]?.n ?? 0) === 0) throw new HttpError(409, 'LAST_ADMIN', 'There must always be at least one active admin.');
}

export async function updateUser(pool: Pool, input: { userId: number; displayName?: string; role?: Role; active?: boolean; actor: AuthUser }): Promise<UserView> {
  if (input.role !== undefined && !isRole(input.role)) throw new HttpError(422, 'BAD_ROLE', `A role is one of: ${ROLES.join(', ')}.`);
  return withTransaction(pool, async (c) => {
    const found = await c.query<UserRow>(`SELECT ${COLS} FROM users WHERE id = $1 FOR UPDATE`, [input.userId]);
    const u = found.rows[0];
    if (!u) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');

    const roleChange = input.role !== undefined && input.role !== u.role;
    const deactivating = input.active === false && u.active;
    if (u.id === input.actor.id && (roleChange || deactivating)) {
      throw new HttpError(409, 'SELF_CHANGE', 'You cannot change your own role or deactivate yourself. Ask another admin.');
    }
    if (u.role === 'admin' && u.active && ((roleChange && input.role !== 'admin') || deactivating)) await assertAnotherAdminRemains(c, u.id);

    const { rows } = await c.query<UserRow>(
      `UPDATE users SET display_name = COALESCE($2, display_name), role = COALESCE($3, role), active = COALESCE($4, active) WHERE id = $1 RETURNING ${COLS}`,
      [u.id, input.displayName?.trim() || null, input.role ?? null, input.active ?? null]);
    // A changed role or a deactivation takes effect at once, not at the next login.
    if (roleChange || deactivating) await revokeSessions(c, u.id);
    if (roleChange) await audit(c, { actor: input.actor.username, role: input.actor.role, action: 'user_role_changed', entityType: 'user', entityId: u.id, risk: 2, details: { username: u.username, from: u.role, to: input.role } });
    if (deactivating) await audit(c, { actor: input.actor.username, role: input.actor.role, action: 'user_deactivated', entityType: 'user', entityId: u.id, risk: 2, details: { username: u.username } });
    if (input.active === true && !u.active) await audit(c, { actor: input.actor.username, role: input.actor.role, action: 'user_reactivated', entityType: 'user', entityId: u.id, risk: 1, details: { username: u.username } });
    return toView(rows[0]!);
  });
}

/** A new one-time password. Signs the person out everywhere, clears any lockout, and forces a change at next login. */
export async function resetPassword(pool: Pool, input: { userId: number; actor: AuthUser }): Promise<{ user: UserView; temporaryPassword: string }> {
  const temp = temporaryPassword();
  const hash = await hashPassword(temp);
  return withTransaction(pool, async (c) => {
    const { rows } = await c.query<UserRow>(
      `UPDATE users SET password_hash = $2, must_change_password = true, failed_attempts = 0, locked_until = NULL WHERE id = $1 RETURNING ${COLS}`, [input.userId, hash]);
    if (!rows[0]) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');
    await revokeSessions(c, input.userId);
    await audit(c, { actor: input.actor.username, role: input.actor.role, action: 'password_reset', entityType: 'user', entityId: input.userId, risk: 2, details: { username: rows[0].username } });
    return { user: toView(rows[0]), temporaryPassword: temp };
  });
}
