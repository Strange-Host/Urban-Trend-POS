import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { audit } from '../pos/audit.js';
import { DUMMY_HASH, hashPassword, temporaryPassword, verifyPassword } from './password.js';
import { assertStrongPassword } from './passwordPolicy.js';
import { assertValidPin } from './pin.js';
import { ROLES, type Role } from './permissions.js';
import { createSession, endAllSessions, endSession, type NewSession, type SessionOptions } from './sessions.js';
import { lockoutRules } from './settings.js';
import type { AuthUser } from './types.js';

export { authenticateToken } from './sessions.js';

// The built-in lockout rules. An admin can change them (security_lockout_attempts / security_lockout_minutes in the settings store).
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
const BAD_LOGIN = () => new HttpError(401, 'BAD_CREDENTIALS', 'Wrong username or password.');

const cleanName = (s: unknown) => String(s ?? '').trim().toLowerCase().slice(0, 64) || 'unknown';

export interface UserView {
  id: number; username: string; displayName: string; role: Role; active: boolean; email: string | null; phone: string | null; hasPin: boolean; twoFactorEnabled: boolean; erased: boolean;
  mustChangePassword: boolean; lockedUntil: Date | null; pinLockedUntil: Date | null; lastLoginAt: Date | null; createdAt: Date; createdBy: string;
}
interface UserRow {
  id: number; username: string; display_name: string; role: Role; active: boolean; email: string | null; phone: string | null; has_pin: boolean; two_factor_enabled: boolean; erased: boolean;
  must_change_password: boolean; locked_until: Date | null; pin_locked_until: Date | null; last_login_at: Date | null; created_at: Date; created_by: string;
}
const COLS = `id, username, display_name, role, active, email, phone, (pin_hash IS NOT NULL) AS has_pin, two_factor_enabled, (erased_at IS NOT NULL) AS erased, must_change_password, locked_until, pin_locked_until, last_login_at, created_at, created_by`;
const toView = (r: UserRow): UserView => ({
  id: r.id, username: r.username, displayName: r.display_name, role: r.role, active: r.active, email: r.email, phone: r.phone, hasPin: r.has_pin, twoFactorEnabled: r.two_factor_enabled, erased: r.erased,
  mustChangePassword: r.must_change_password, lockedUntil: r.locked_until, pinLockedUntil: r.pin_locked_until, lastLoginAt: r.last_login_at, createdAt: r.created_at, createdBy: r.created_by,
});

/** Kept for callers that revoked sessions before sessions had their own module. */
export const revokeSessions = (db: Queryable, userId: number, exceptSessionId?: number) => endAllSessions(db, userId, { exceptSessionId, reason: 'revoked' });

// ------------------------------------------------------------------------------------------------ the sign-in guard

// Wrong passwords and wrong PINs are counted per account and locked SEPARATELY: someone guessing a four-digit till PIN can lock the
// PIN but not the person's password sign-in. The counter restarts at zero when it locks, so after the lock ends there is a fresh set of tries.
export type Channel = 'password' | 'pin';
const CHANNEL_COLS: Record<Channel, { count: string; until: string }> = {
  password: { count: 'failed_attempts', until: 'locked_until' },
  pin: { count: 'pin_failed_attempts', until: 'pin_locked_until' },
};
const word = (c: Channel) => (c === 'pin' ? 'PINs' : 'passwords');

interface CredentialRow extends UserRow { password_hash: string; pin_hash: string | null; until: Date | null }

async function loadCredentials(db: Queryable, where: string, arg: string | number, channel: Channel): Promise<CredentialRow | undefined> {
  const c = CHANNEL_COLS[channel];
  const { rows } = await db.query<CredentialRow>(`SELECT ${COLS}, password_hash, pin_hash, ${c.until} AS until FROM users WHERE ${where}`, [arg]);
  return rows[0];
}

/** Throws 423 while this account's channel is locked. Called BEFORE the secret is checked, so a locked account answers the same whether or not the secret is right. */
async function assertNotLocked(pool: Pool, u: CredentialRow, channel: Channel): Promise<void> {
  if (u.until && u.until > new Date()) {
    await audit(pool, { actor: u.username, role: u.role, action: 'login_blocked', entityType: 'user', entityId: u.id, risk: 1, details: { reason: 'locked', channel } });
    const minutes = Math.max(1, Math.ceil((u.until.getTime() - Date.now()) / 60_000));
    throw new HttpError(423, 'ACCOUNT_LOCKED', `Too many wrong ${word(channel)}. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}, or ask an admin.`);
  }
}

/** Counts a wrong attempt. Returns whether this one locked the account. */
async function recordFailure(pool: Pool, u: { id: number; username: string; role: Role }, channel: Channel, extra: Record<string, unknown> = {}): Promise<boolean> {
  const c = CHANNEL_COLS[channel];
  const rules = await lockoutRules(pool);
  const upd = await pool.query<{ n: number; locked: boolean }>(
    `UPDATE users SET ${c.count} = CASE WHEN ${c.count} + 1 >= $2 THEN 0 ELSE ${c.count} + 1 END,
            ${c.until} = CASE WHEN ${c.count} + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE ${c.until} END
      WHERE id = $1 RETURNING ${c.count} AS n, (${c.until} IS NOT NULL AND ${c.until} > now()) AS locked`, [u.id, rules.attempts, rules.minutes]);
  const locked = upd.rows[0]?.locked ?? false;
  await audit(pool, { actor: u.username, role: u.role, action: locked ? 'account_locked' : 'login_failed', entityType: 'user', entityId: u.id, risk: locked ? 2 : 1,
    details: { channel, attempts: locked ? rules.attempts : upd.rows[0]?.n ?? 0, ...extra } });
  return locked;
}

async function recordSuccess(pool: Pool, u: { id: number }, channel: Channel): Promise<void> {
  const c = CHANNEL_COLS[channel];
  await pool.query(`UPDATE users SET ${c.count} = 0, ${c.until} = NULL WHERE id = $1 AND (${c.count} > 0 OR ${c.until} IS NOT NULL)`, [u.id]);
}

const identifierWhere = 'username = $1 OR email = $1';

/**
 * Checks a username-or-email and a password with the same protections as logging in: one answer for "no such user" and "wrong
 * password", the same cost either way, lockout after repeated failures, and an audit row for every miss. Returns the person on success.
 */
export async function verifyCredentials(pool: Pool, identifier: string, password: string): Promise<UserView> {
  return (await checkPassword(pool, identifier, password)).view;
}

async function checkPassword(pool: Pool, identifier: string, password: string): Promise<{ view: UserView; row: CredentialRow }> {
  const name = cleanName(identifier);
  const lookup = String(identifier ?? '').trim().toLowerCase().slice(0, 254); // an email can be longer than a username
  const u = await loadCredentials(pool, identifierWhere, lookup, 'password');
  if (!u) {
    await verifyPassword(password, DUMMY_HASH); // same cost as a real check, so timing does not reveal which accounts exist
    await audit(pool, { actor: name, action: 'login_failed', entityType: 'user', risk: 1, details: { reason: 'unknown_user' } });
    throw BAD_LOGIN();
  }
  await assertNotLocked(pool, u, 'password');
  const ok = await verifyPassword(password, u.password_hash);
  if (!ok) { await recordFailure(pool, u, 'password'); throw BAD_LOGIN(); }
  if (!u.active) {
    await audit(pool, { actor: u.username, role: u.role, action: 'login_failed', entityType: 'user', entityId: u.id, risk: 1, details: { reason: 'inactive' } });
    throw BAD_LOGIN();
  }
  await recordSuccess(pool, u, 'password');
  return { view: toView(u), row: u };
}

export interface Opened extends NewSession { user: UserView }

async function openSession(pool: Pool, user: UserView, opts: SessionOptions & { method: 'password' | 'pin' }): Promise<Opened> {
  const opened = await createSession(pool, user, opts);
  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  await audit(pool, { actor: user.username, role: user.role, action: 'login', entityType: 'user', entityId: user.id, details: { method: opts.method, remember: opts.remember === true } });
  return { ...opened, user: { ...user, lastLoginAt: new Date() } };
}

// An account with sign-in codes switched on cannot be signed in by password alone. Codes by SMS arrive with the SMS port; until then
// such an account is refused rather than quietly let in without its second step.
const TWO_FACTOR_PENDING = () => new HttpError(403, 'TWO_FACTOR_UNAVAILABLE', 'This account needs a sign-in code, and sign-in codes are not available on this server yet. Ask an admin.');

export async function login(pool: Pool, input: { username: string; password: string } & SessionOptions): Promise<Opened> {
  const { view, row } = await checkPassword(pool, input.username, input.password);
  if (row.two_factor_enabled) throw TWO_FACTOR_PENDING();
  return openSession(pool, view, { ...input, method: 'password' });
}

/** Fast sign-in at a shared register: a cashier's PIN. Never signs in an admin or a manager, and never "remembers" the device. */
export async function loginWithPin(pool: Pool, input: { userId: number; pin: string } & SessionOptions): Promise<Opened> {
  const u = await loadCredentials(pool, 'id = $1', input.userId, 'pin');
  if (!u || !u.active) {
    await verifyPassword(String(input.pin), DUMMY_HASH);
    await audit(pool, { actor: `user#${input.userId}`, action: 'login_failed', entityType: 'user', risk: 1, details: { reason: 'unknown_user', channel: 'pin' } });
    throw new HttpError(401, 'BAD_PIN', 'Invalid PIN.');
  }
  await assertNotLocked(pool, u, 'pin');
  const ok = await verifyPassword(String(input.pin), u.pin_hash ?? DUMMY_HASH);
  if (!ok || !u.pin_hash) { await recordFailure(pool, u, 'pin'); throw new HttpError(401, 'BAD_PIN', 'Invalid PIN.'); }
  await recordSuccess(pool, u, 'pin');
  if (u.two_factor_enabled) throw new HttpError(403, 'PIN_LOGIN_DISABLED', 'This account needs full sign-in. PIN sign-in is not available.');
  if (u.role !== 'cashier') throw new HttpError(403, 'PIN_LOGIN_CASHIERS_ONLY', 'PIN sign-in is only for cashier accounts. Sign in with your email and password.');
  return openSession(pool, toView(u), { ...input, remember: false, method: 'pin' });
}

/**
 * "Confirm it's you": the signed-in person types their own password (or, for a cashier with a PIN, the PIN) again. Used to open a
 * locked screen and before risky actions. Wrong tries count toward the same lockout as signing in.
 */
export async function confirmIdentity(pool: Pool, user: AuthUser, secret: { password?: string; pin?: string }): Promise<void> {
  const usingPin = secret.pin !== undefined && secret.password === undefined;
  const channel: Channel = usingPin ? 'pin' : 'password';
  const u = await loadCredentials(pool, 'id = $1 AND active', user.id, channel);
  if (!u) throw new HttpError(401, 'SESSION_INVALID', 'Your session has ended. Log in again.');
  if (usingPin && (u.role !== 'cashier' || !u.pin_hash || u.two_factor_enabled)) throw new HttpError(403, 'PIN_NOT_ALLOWED', 'Use your password to continue.');
  await assertNotLocked(pool, u, channel);
  const ok = usingPin ? await verifyPassword(String(secret.pin), u.pin_hash!) : await verifyPassword(String(secret.password), u.password_hash);
  if (!ok) {
    const locked = await recordFailure(pool, u, channel, { during: 'confirm' });
    throw new HttpError(401, usingPin ? 'BAD_PIN' : 'BAD_CREDENTIALS', locked ? `Too many wrong ${word(channel)}. It is locked for a while.` : usingPin ? 'Incorrect PIN.' : 'Incorrect password.');
  }
  await recordSuccess(pool, u, channel);
}

export async function logout(pool: Pool, user: AuthUser): Promise<void> {
  await endSession(pool, user.sessionId, 'signed_out');
  await audit(pool, { actor: user.username, role: user.role, action: 'logout', entityType: 'user', entityId: user.id });
}

export async function getUser(db: Queryable, id: number): Promise<UserView | null> {
  const { rows } = await db.query<UserRow>(`SELECT ${COLS} FROM users WHERE id = $1`, [id]);
  return rows[0] ? toView(rows[0]) : null;
}

export async function changeOwnPassword(pool: Pool, user: AuthUser, input: { currentPassword: string; newPassword: string }): Promise<void> {
  const u = await loadCredentials(pool, 'id = $1', user.id, 'password');
  if (u) await assertNotLocked(pool, u, 'password');
  if (!u || !(await verifyPassword(input.currentPassword, u.password_hash))) {
    if (u) await recordFailure(pool, u, 'password', { during: 'change_password' });
    else await audit(pool, { actor: user.username, role: user.role, action: 'password_change_failed', entityType: 'user', entityId: user.id, risk: 1 });
    throw new HttpError(403, 'WRONG_CURRENT_PASSWORD', 'The current password is not right.');
  }
  if (input.newPassword === input.currentPassword) throw new HttpError(422, 'PASSWORD_UNCHANGED', 'Choose a different password from the current one.');
  assertStrongPassword(input.newPassword, { role: u.role, username: u.username, email: u.email, displayName: u.display_name, phone: u.phone });
  const hash = await hashPassword(input.newPassword);
  await withTransaction(pool, async (c) => {
    await c.query(`UPDATE users SET password_hash = $2, must_change_password = false, failed_attempts = 0, locked_until = NULL, password_changed_at = now() WHERE id = $1`, [user.id, hash]);
    await endAllSessions(c, user.id, { exceptSessionId: user.sessionId, reason: 'password_changed' }); // a changed password signs out every other device
    await audit(c, { actor: user.username, role: user.role, action: 'password_changed', entityType: 'user', entityId: user.id, risk: 1 });
  });
}

// ------------------------------------------------------------------------------------------------ user management (admin)

export async function listUsers(db: Queryable): Promise<UserView[]> {
  const { rows } = await db.query<UserRow>(`SELECT ${COLS} FROM users ORDER BY active DESC, username`);
  return rows.map(toView);
}

const isRole = (r: unknown): r is Role => ROLES.includes(r as Role);
const cleanEmail = (e: string | null | undefined): string | null => {
  const v = (e ?? '').trim().toLowerCase();
  if (!v) return null;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || v.length > 254) throw new HttpError(422, 'BAD_EMAIL', 'That email address does not look right.');
  return v;
};
const cleanPhone = (p: string | null | undefined): string | null => ((p ?? '').trim().slice(0, 30) || null);

function uniqueViolation(err: unknown): HttpError | null {
  const e = err as { code?: string; constraint?: string };
  if (e.code !== '23505') return null;
  if (e.constraint === 'users_email_unique') return new HttpError(409, 'EMAIL_TAKEN', 'That email address is already used by another account.');
  if (e.constraint === 'retired_username') return new HttpError(409, 'USERNAME_RETIRED', 'That username belonged to a deleted account and can never be used again. Choose another.');
  return new HttpError(409, 'USERNAME_TAKEN', 'That username is already used.');
}

/** Creates an account with a one-time password, shown once. The person must change it at first login. */
export async function createUser(pool: Pool, input: { username: string; displayName: string; role: Role; email?: string | null; phone?: string | null; pin?: string | null; actor: string; actorRole?: Role }): Promise<{ user: UserView; temporaryPassword: string }> {
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(username)) {
    throw new HttpError(422, 'BAD_USERNAME', 'A username is 2 to 32 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.');
  }
  if (!isRole(input.role)) throw new HttpError(422, 'BAD_ROLE', `A role is one of: ${ROLES.join(', ')}.`);
  const email = cleanEmail(input.email);
  if (input.pin) assertValidPin(input.pin);
  const temp = temporaryPassword();
  const hash = await hashPassword(temp);
  const pinHash = input.pin ? await hashPassword(input.pin) : null;
  try {
    return await withTransaction(pool, async (c) => {
      const { rows } = await c.query<UserRow>(
        `INSERT INTO users (username, display_name, role, password_hash, email, phone, pin_hash, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLS}`,
        [username, input.displayName.trim(), input.role, hash, email, cleanPhone(input.phone), pinHash, input.actor]);
      await audit(c, { actor: input.actor, role: input.actorRole, action: 'user_created', entityType: 'user', entityId: rows[0]!.id, risk: 1, details: { username, role: input.role, hasEmail: email !== null, hasPin: pinHash !== null } });
      return { user: toView(rows[0]!), temporaryPassword: temp };
    });
  } catch (err) {
    throw uniqueViolation(err) ?? err;
  }
}

/** Never leaves the shop without an admin: demoting or deactivating the last active admin is refused. */
async function assertAnotherAdminRemains(c: Queryable, exceptUserId: number): Promise<void> {
  const { rows } = await c.query<{ n: string }>(`SELECT count(*) AS n FROM users WHERE role = 'admin' AND active AND id <> $1`, [exceptUserId]);
  if (Number(rows[0]?.n ?? 0) === 0) throw new HttpError(409, 'LAST_ADMIN', 'There must always be at least one active admin.');
}

export async function updateUser(pool: Pool, input: { userId: number; displayName?: string; role?: Role; active?: boolean; email?: string | null; phone?: string | null; actor: AuthUser }): Promise<UserView> {
  if (input.role !== undefined && !isRole(input.role)) throw new HttpError(422, 'BAD_ROLE', `A role is one of: ${ROLES.join(', ')}.`);
  const emailGiven = input.email !== undefined;
  const email = emailGiven ? cleanEmail(input.email) : null;
  try {
    return await withTransaction(pool, async (c) => {
      const found = await c.query<UserRow>(`SELECT ${COLS} FROM users WHERE id = $1 FOR UPDATE`, [input.userId]);
      const u = found.rows[0];
      if (!u) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');

      if (u.erased) throw new HttpError(409, 'ACCOUNT_ERASED', 'This account was erased and cannot be changed.');
      const roleChange = input.role !== undefined && input.role !== u.role;
      const deactivating = input.active === false && u.active;
      if (u.id === input.actor.id && (roleChange || deactivating)) {
        throw new HttpError(409, 'SELF_CHANGE', 'You cannot change your own role or deactivate yourself. Ask another admin.');
      }
      if (u.role === 'admin' && u.active && ((roleChange && input.role !== 'admin') || deactivating)) await assertAnotherAdminRemains(c, u.id);

      const { rows } = await c.query<UserRow>(
        `UPDATE users SET display_name = COALESCE($2, display_name), role = COALESCE($3, role), active = COALESCE($4, active),
                email = CASE WHEN $5::boolean THEN $6 ELSE email END, phone = CASE WHEN $7::boolean THEN $8 ELSE phone END,
                failed_attempts = CASE WHEN $4::boolean IS TRUE AND NOT active THEN 0 ELSE failed_attempts END,
                locked_until = CASE WHEN $4::boolean IS TRUE AND NOT active THEN NULL ELSE locked_until END,
                pin_failed_attempts = CASE WHEN $4::boolean IS TRUE AND NOT active THEN 0 ELSE pin_failed_attempts END,
                pin_locked_until = CASE WHEN $4::boolean IS TRUE AND NOT active THEN NULL ELSE pin_locked_until END
          WHERE id = $1 RETURNING ${COLS}`,
        [u.id, input.displayName?.trim() || null, input.role ?? null, input.active ?? null, emailGiven, email, input.phone !== undefined, cleanPhone(input.phone)]);
      // A changed role or a deactivation takes effect at once, not at the next login.
      if (roleChange || deactivating) await endAllSessions(c, u.id, { reason: deactivating ? 'deactivated' : 'role_changed' });
      if (roleChange) await audit(c, { actor: input.actor.username, role: input.actor.role, action: 'user_role_changed', entityType: 'user', entityId: u.id, risk: 2, details: { username: u.username, from: u.role, to: input.role } });
      if (deactivating) await audit(c, { actor: input.actor.username, role: input.actor.role, action: 'user_deactivated', entityType: 'user', entityId: u.id, risk: 2, details: { username: u.username } });
      if (input.active === true && !u.active) await audit(c, { actor: input.actor.username, role: input.actor.role, action: 'user_reactivated', entityType: 'user', entityId: u.id, risk: 1, details: { username: u.username } });
      if (emailGiven && email !== u.email) await audit(c, { actor: input.actor.username, role: input.actor.role, action: 'user_email_changed', entityType: 'user', entityId: u.id, risk: 1, details: { username: u.username } });
      return toView(rows[0]!);
    });
  } catch (err) {
    throw uniqueViolation(err) ?? err;
  }
}

/** A new one-time password. Signs the person out everywhere, clears any lockout, and forces a change at next login. */
export async function resetPassword(pool: Pool, input: { userId: number; actor: AuthUser }): Promise<{ user: UserView; temporaryPassword: string }> {
  const temp = temporaryPassword();
  const hash = await hashPassword(temp);
  return withTransaction(pool, async (c) => {
    const { rows } = await c.query<UserRow>(
      `UPDATE users SET password_hash = $2, must_change_password = true, failed_attempts = 0, locked_until = NULL, password_changed_at = now() WHERE id = $1 AND erased_at IS NULL RETURNING ${COLS}`, [input.userId, hash]);
    if (!rows[0]) throw await missingOrErased(c, input.userId);
    await endAllSessions(c, input.userId, { reason: 'password_reset' });
    await audit(c, { actor: input.actor.username, role: input.actor.role, action: 'password_reset', entityType: 'user', entityId: input.userId, risk: 2, details: { username: rows[0].username } });
    return { user: toView(rows[0]), temporaryPassword: temp };
  });
}

async function missingOrErased(db: Queryable, id: number): Promise<HttpError> {
  const u = await getUser(db, id);
  return u?.erased ? new HttpError(409, 'ACCOUNT_ERASED', 'This account was erased and cannot be changed.') : new HttpError(404, 'USER_NOT_FOUND', 'User not found.');
}

/** Sets, changes or (with null) removes a register PIN. A PIN is a short shortcut, so the only protection it has is that it is not obvious. */
export async function setPin(pool: Pool, input: { userId: number; pin: string | null; actor: AuthUser }): Promise<UserView> {
  if (input.pin !== null) assertValidPin(input.pin);
  const hash = input.pin === null ? null : await hashPassword(input.pin);
  return withTransaction(pool, async (c) => {
    const { rows } = await c.query<UserRow>(`UPDATE users SET pin_hash = $2, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1 AND erased_at IS NULL RETURNING ${COLS}`, [input.userId, hash]);
    if (!rows[0]) throw await missingOrErased(c, input.userId);
    await audit(c, { actor: input.actor.username, role: input.actor.role, action: hash ? 'pin_set' : 'pin_removed', entityType: 'user', entityId: input.userId, risk: 1, details: { username: rows[0].username } });
    return toView(rows[0]);
  });
}

/** Lifts a wrong-password or wrong-PIN lockout right now. */
export async function unlockAccount(pool: Pool, input: { userId: number; actor: AuthUser }): Promise<UserView> {
  return withTransaction(pool, async (c) => {
    const { rows } = await c.query<UserRow>(
      `UPDATE users SET failed_attempts = 0, locked_until = NULL, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1 RETURNING ${COLS}`, [input.userId]);
    if (!rows[0]) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');
    await audit(c, { actor: input.actor.username, role: input.actor.role, action: 'account_unlocked', entityType: 'user', entityId: input.userId, risk: 1, details: { username: rows[0].username } });
    return toView(rows[0]);
  });
}

export async function signOutEverywhere(pool: Pool, input: { userId: number; actor: AuthUser }): Promise<number> {
  const user = await getUser(pool, input.userId);
  if (!user) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');
  const ended = await endAllSessions(pool, input.userId, { reason: 'signed_out_by_admin' });
  await audit(pool, { actor: input.actor.username, role: input.actor.role, action: 'signed_out_everywhere', entityType: 'user', entityId: input.userId, risk: 1, details: { username: user.username, ended } });
  return ended;
}
