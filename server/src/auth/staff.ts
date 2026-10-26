import { randomBytes } from 'node:crypto';
import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { audit } from '../pos/audit.js';
import { hashPassword } from './password.js';
import { endAllSessions } from './sessions.js';
import type { Role } from './permissions.js';
import type { AuthUser } from './types.js';

// Taking a person out of the system without breaking the records they leave behind. See migration 0011 for the three ways.

/** Sign-in noise, not work: an account whose only trace is that it signed in (or changed its own password) "never did anything". */
const SIGN_IN_ACTIONS = ['login', 'logout', 'login_failed', 'login_blocked', 'account_locked', 'password_changed', 'password_change_failed', 'refresh_token_reuse'];

/**
 * Columns that only note who touched something last, or hold the person's own settings. They never count as history.
 * Everything else that names a person is found from the database itself (see personColumns), so a table added later is covered
 * without anyone remembering to list it here.
 */
export const NOT_HISTORY = new Set(['user_permissions.updated_by', 'app_settings.updated_by', 'retired_usernames.retired_by', 'audit_log.actor']);

const LABELS: Record<string, string> = {
  alerts: 'alerts', attendance_records: 'attendance records', cash_movements: 'cash movements', cash_sessions: 'till sessions',
  commission_plans: 'commission plans', commissioned_orders: 'commissions', courier_costs: 'courier costs', courier_payouts: 'courier payouts', couriers: 'couriers',
  custody_records: 'custody records', customers: 'customers', delivery_attempts: 'delivery attempts', discount_approvals: 'discount approvals',
  discount_policies: 'discount policies', exception_resolutions: 'payment reviews', journal_entries: 'ledger entries', lead_messages: 'lead notes', leads: 'leads',
  order_events: 'order updates', order_returns: 'returned parcels', orders: 'orders', org_collections: 'organization collections', org_statements: 'organization statements',
  package_fees: 'courier fees', pay_profiles: 'pay profiles', payment_receipts: 'receipts', payroll_adjustments: 'payroll entries', payroll_items: 'payroll entries',
  payroll_runs: 'payroll runs', products: 'products', sale_refunds: 'refunds', sales: 'sales', stock_movements: 'stock changes', audit_log: 'logged actions',
};
const labelOf = (table: string) => LABELS[table] ?? table.replace(/_/g, ' ');

interface Column { table: string; column: string }

/** Every text column in the database that holds a person's username: actor, cashier, approver, anything ending in _by, and so on. */
export async function personColumns(db: Queryable): Promise<Column[]> {
  const { rows } = await db.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = current_schema() AND c.data_type = 'text'
        AND c.table_name NOT IN ('users', 'schema_migrations')
        AND (c.column_name IN ('actor', 'cashier', 'approver', 'assigned_to', 'staff_key') OR c.column_name LIKE '%\\_by')
      ORDER BY c.table_name, c.column_name`);
  return rows.map((r) => ({ table: r.table_name, column: r.column_name })).filter((c) => !NOT_HISTORY.has(`${c.table}.${c.column}`));
}

/** What this username did, by kind: { 'sales': 40, 'stock changes': 3 }. Empty means the account never did anything. */
export async function activityOf(db: Queryable, username: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const add = (label: string, n: number) => { if (n > 0) out[label] = (out[label] ?? 0) + n; };
  for (const { table, column } of await personColumns(db)) {
    const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM "${table}" WHERE "${column}" = $1`, [username]);
    add(labelOf(table), Number(rows[0]?.n ?? 0));
  }
  const log = await db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE actor = $1 AND NOT (action = ANY($2::text[]))`, [username, SIGN_IN_ACTIONS]);
  add(labelOf('audit_log'), Number(log.rows[0]?.n ?? 0));
  return out;
}

interface Target { id: number; username: string; display_name: string; role: Role; active: boolean; erased_at: Date | null }
async function load(db: Queryable, id: number, lock = false): Promise<Target> {
  const { rows } = await db.query<Target>(`SELECT id, username, display_name, role, active, erased_at FROM users WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!rows[0]) throw new HttpError(404, 'USER_NOT_FOUND', 'User not found.');
  return rows[0];
}
async function isLastAdmin(db: Queryable, u: Target): Promise<boolean> {
  if (u.role !== 'admin' || !u.active) return false;
  const { rows } = await db.query<{ n: string }>(`SELECT count(*) AS n FROM users WHERE role = 'admin' AND active AND id <> $1`, [u.id]);
  return Number(rows[0]?.n ?? 0) === 0;
}

export interface RemovalCheck {
  id: number; username: string; displayName: string; role: Role; active: boolean; erased: boolean;
  activity: Record<string, number>; hasActivity: boolean;
  canDeletePermanently: boolean; canErase: boolean; eraseNeedsDeactivation: boolean; reasons: string[];
}

/** What can be done with this account, and why not. Drives the buttons on the Staff page. */
export async function removalCheck(db: Queryable, input: { userId: number; actor: Pick<AuthUser, 'id'> }): Promise<RemovalCheck> {
  const u = await load(db, input.userId);
  const self = u.id === input.actor.id;
  const lastAdmin = await isLastAdmin(db, u);
  const activity = await activityOf(db, u.username);
  const hasActivity = Object.keys(activity).length > 0;
  const reasons: string[] = [];
  if (self) reasons.push('You cannot remove your own account.');
  if (lastAdmin) reasons.push('This is the only active admin. Make another admin first.');
  if (hasActivity) reasons.push(`This account has history (${Object.entries(activity).map(([k, v]) => `${v} ${k}`).join(', ')}), which must be kept.`);
  return {
    id: u.id, username: u.username, displayName: u.display_name, role: u.role, active: u.active, erased: u.erased_at !== null,
    activity, hasActivity,
    canDeletePermanently: !self && !lastAdmin && !hasActivity && u.erased_at === null,
    canErase: !self && !lastAdmin && !u.active && u.erased_at === null,
    eraseNeedsDeactivation: u.active && u.erased_at === null,
    reasons,
  };
}

const confirmed = (typed: unknown, u: Target) => {
  if (String(typed ?? '').trim() !== u.display_name) throw new HttpError(422, 'CONFIRMATION_MISMATCH', "Type the person's full name to confirm.");
};

export async function reactivate(pool: Pool, input: { userId: number; actor: AuthUser }) {
  return withTransaction(pool, async (c) => {
    const u = await load(c, input.userId, true);
    if (u.erased_at) throw new HttpError(409, 'ACCOUNT_ERASED', "This account's personal data was erased, so it cannot be reactivated. Create a new account instead.");
    if (u.active) return { id: u.id, username: u.username, alreadyActive: true };
    // Comes back with a clean slate: no leftover lockout from the day they left.
    await c.query(`UPDATE users SET active = true, failed_attempts = 0, locked_until = NULL, pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1`, [u.id]);
    await audit(c, { actor: input.actor.username, role: input.actor.role, action: 'user_reactivated', entityType: 'user', entityId: u.id, risk: 1, details: { username: u.username } });
    return { id: u.id, username: u.username, alreadyActive: false };
  });
}

/** For an account that never did anything (a test account, a mistake). The row goes; the username is retired for good. */
export async function deletePermanently(pool: Pool, input: { userId: number; confirmName: string; actor: AuthUser }) {
  return withTransaction(pool, async (c) => {
    const u = await load(c, input.userId, true);
    confirmed(input.confirmName, u);
    const check = await removalCheck(c, { userId: u.id, actor: input.actor });
    if (!check.canDeletePermanently) throw new HttpError(409, 'CANNOT_DELETE_ACCOUNT', check.reasons.join(' ') || 'This account cannot be deleted.', { activity: check.activity });
    const snapshot = await c.query<{ email: string | null }>(`SELECT email FROM users WHERE id = $1`, [u.id]);
    await c.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [u.id]); // before sessions: refresh tokens point at them
    await c.query(`DELETE FROM sessions WHERE user_id = $1`, [u.id]);
    await c.query(`DELETE FROM user_permissions WHERE user_id = $1`, [u.id]);
    await c.query(`INSERT INTO retired_usernames (username, retired_by) VALUES ($1, $2)`, [u.username, input.actor.username]);
    await audit(c, { actor: input.actor.username, role: input.actor.role, action: 'user_deleted', entityType: 'user', entityId: u.id, risk: 2, details: { username: u.username, role: u.role, email: snapshot.rows[0]?.email ?? null } });
    await c.query(`SELECT set_config('app.allow_user_delete', 'on', true)`); // this transaction only
    await c.query(`DELETE FROM users WHERE id = $1`, [u.id]);
    return { deleted: true, id: u.id, username: u.username };
  });
}

/** For former staff who have history: wipe who they are, keep what they did. */
export async function erasePersonalData(pool: Pool, input: { userId: number; confirmName: string; actor: AuthUser }) {
  const unusable = await hashPassword(randomBytes(32).toString('hex')); // nobody knows it, and the account cannot sign in anyway
  return withTransaction(pool, async (c) => {
    const u = await load(c, input.userId, true);
    if (u.erased_at) throw new HttpError(409, 'ACCOUNT_ERASED', 'This account was already erased.');
    const check = await removalCheck(c, { userId: u.id, actor: input.actor });
    if (check.eraseNeedsDeactivation) throw new HttpError(409, 'DEACTIVATE_FIRST', 'Deactivate the account first, then erase its personal data.');
    if (!check.canErase) throw new HttpError(409, 'CANNOT_ERASE_ACCOUNT', check.reasons.join(' ') || 'This account cannot be erased.');
    confirmed(input.confirmName, u);
    await c.query(
      `UPDATE users SET display_name = $2, email = NULL, phone = NULL, password_hash = $3, pin_hash = NULL, two_factor_enabled = false,
              must_change_password = false, failed_attempts = 0, locked_until = NULL, pin_failed_attempts = 0, pin_locked_until = NULL,
              active = false, erased_at = now() WHERE id = $1`, [u.id, `Former staff #${u.id}`, unusable]);
    await c.query(`DELETE FROM user_permissions WHERE user_id = $1`, [u.id]);
    await endAllSessions(c, u.id, { reason: 'erased' });
    // The audit trail is append-only, so earlier entries keep the username (the key on their records) and nothing else about the person.
    await audit(c, { actor: input.actor.username, role: input.actor.role, action: 'user_erased', entityType: 'user', entityId: u.id, risk: 2, details: { username: u.username } });
    return { id: u.id, username: u.username, displayName: `Former staff #${u.id}`, erased: true };
  });
}
