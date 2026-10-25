import type { Queryable } from '../db/tx.js';
import { withTransaction } from '../db/tx.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { audit } from '../pos/audit.js';
import { CATALOG, CATALOG_KEYS, catalogDefault } from './catalog.js';
import { canUser, type Role } from './permissions.js';
import type { AuthUser } from './types.js';

// "Staff access": the admin grants or revokes a single permission for one person on top of their role. Admin is always
// unrestricted, so a bad override can never lock the shop out of its own system.

export async function overridesFor(db: Queryable, userId: number): Promise<Record<string, boolean>> {
  const { rows } = await db.query<{ permission: string; granted: boolean }>(`SELECT permission, granted FROM user_permissions WHERE user_id = $1`, [userId]);
  return Object.fromEntries(rows.map((r) => [r.permission, r.granted]));
}

/** What the editor shows: every key with its group, the role default, any explicit override, and the resulting effective value. */
export async function describeForUser(db: Queryable, userId: number) {
  const { rows } = await db.query<{ id: number; username: string; display_name: string; role: Role }>(`SELECT id, username, display_name, role FROM users WHERE id = $1`, [userId]);
  const u = rows[0];
  if (!u) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');
  const overrides = await overridesFor(db, userId);
  return {
    user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role },
    locked: u.role === 'admin', // admins cannot be restricted
    permissions: CATALOG.map((e) => {
      const roleDefault = catalogDefault(u.role, e.key);
      const override = Object.prototype.hasOwnProperty.call(overrides, e.key) ? overrides[e.key]! : null;
      return { key: e.key, group: e.group, label: e.label, roleDefault, override, effective: u.role === 'admin' ? true : override ?? roleDefault };
    }),
  };
}

/** The keys this person can use, as the Staff access editor names them (the browser uses these to decide what to show). */
export async function effectiveEditorKeys(db: Queryable, user: { id: number; role: Role }): Promise<string[]> {
  const overrides = await overridesFor(db, user.id);
  return CATALOG.filter((e) => user.role === 'admin' || (Object.prototype.hasOwnProperty.call(overrides, e.key) ? overrides[e.key]! : catalogDefault(user.role, e.key))).map((e) => e.key);
}

/**
 * overrides: { [key]: true | false | null }. true or false sets an explicit grant or revoke; null removes the override (back to the
 * role default). An override that merely restates the default is stored as no override, so changing a role's defaults later still
 * reaches everyone who was never individually customised.
 */
export async function setOverrides(pool: Pool, input: { userId: number; overrides: Record<string, boolean | null>; actor: AuthUser }) {
  const unknown = Object.keys(input.overrides).filter((k) => !CATALOG_KEYS.has(k));
  if (unknown.length) throw new HttpError(422, 'UNKNOWN_PERMISSION', `Unknown permission: ${unknown.join(', ')}.`);
  await withTransaction(pool, async (c) => {
    const found = await c.query<{ id: number; role: Role; username: string }>(`SELECT id, role, username FROM users WHERE id = $1 FOR UPDATE`, [input.userId]);
    const u = found.rows[0];
    if (!u) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');
    if (u.role === 'admin') throw new HttpError(409, 'ADMIN_UNRESTRICTED', 'Admins always have every permission and cannot be restricted.');
    if (u.id === input.actor.id) throw new HttpError(409, 'SELF_CHANGE', 'You cannot change your own permissions. Ask another admin.');
    const before = await overridesFor(c, u.id);
    for (const [key, value] of Object.entries(input.overrides)) {
      if (value === null || value === catalogDefault(u.role, key)) await c.query(`DELETE FROM user_permissions WHERE user_id = $1 AND permission = $2`, [u.id, key]);
      else await c.query(
        `INSERT INTO user_permissions (user_id, permission, granted, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, permission) DO UPDATE SET granted = EXCLUDED.granted, updated_by = EXCLUDED.updated_by, updated_at = now()`, [u.id, key, value, input.actor.username]);
    }
    const after = await overridesFor(c, u.id);
    await audit(c, { actor: input.actor.username, role: input.actor.role, action: 'permissions_changed', entityType: 'user', entityId: u.id, risk: 2, details: { username: u.username, before, after } });
  });
  return describeForUser(pool, input.userId);
}

/** Whether a person (found by id, for example an approver who just typed their credentials) is allowed a permission, overrides included. */
export async function userCan(db: Queryable, user: { id: number; role: Role }, permission: Parameters<typeof canUser>[1]): Promise<boolean> {
  return canUser({ role: user.role, overrides: await overridesFor(db, user.id) }, permission);
}
