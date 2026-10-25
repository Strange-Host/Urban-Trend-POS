import type { Pool } from '../db/pool.js';
import type { Queryable } from '../db/tx.js';
import type { Role } from './permissions.js';

// A small key-value store. The security rules use the same key names the legacy Security page already writes, so that page
// can be ported without translating anything.
const TTL_MS = 10_000;
let generation = 0; // bumped on every change, so a cached copy from before the change is never used
const cache = new WeakMap<object, { at: number; gen: number; values: Record<string, string> }>();

export async function getSettings(db: Pool): Promise<Record<string, string>> {
  const hit = cache.get(db);
  if (hit && hit.gen === generation && Date.now() - hit.at < TTL_MS) return hit.values;
  const { rows } = await db.query<{ key: string; value: string }>(`SELECT key, value FROM app_settings`);
  const values = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cache.set(db, { at: Date.now(), gen: generation, values });
  return values;
}

export async function setSettings(db: Queryable, entries: Record<string, string>, actor: string): Promise<void> {
  for (const [key, value] of Object.entries(entries)) {
    await db.query(
      `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, value, actor]);
  }
  generation++;
}

/** Anything that changes settings behind this module's back (a test, a manual fix) calls this so the next request sees it at once. */
export function clearSettingsCache(): void { generation++; }

const int = (v: string | undefined, dflt: number, min: number, max: number): number => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export interface SessionPolicy {
  lockMinutes: number;          // idle this long and the screen locks: only the password or PIN opens it again
  idleSignOutMinutes: number;   // idle this long (and not "remember this device") and the session ends
  maxHours: number;             // hard maximum for a remembered session
  unrememberedMaxHours: number; // hard maximum for one that is not remembered
  reauthMinutes: number;        // how long "confirm it's you" stays good
}

// [lock, idle sign-out, max hours] by role: the legacy defaults.
const BY_ROLE: Record<Role, [number, number, number]> = { cashier: [5, 30, 12], manager: [10, 60, 168], admin: [10, 30, 24] };

/** `unrememberedDefaultHours` is the SESSION_HOURS setting of the server: the default for how long a session that is not remembered may last. */
export async function sessionPolicy(db: Pool, role: Role, unrememberedDefaultHours = 12): Promise<SessionPolicy> {
  const s = await getSettings(db);
  const d = BY_ROLE[role] ?? BY_ROLE.cashier;
  return {
    lockMinutes: int(s[`security_lock_minutes_${role}`], d[0], 1, 1440),
    idleSignOutMinutes: int(s[`security_idle_signout_minutes_${role}`], d[1], 1, 10080),
    maxHours: int(s[`security_max_session_hours_${role}`], d[2], 1, 720),
    unrememberedMaxHours: int(s.security_unremembered_max_hours, unrememberedDefaultHours, 1, 720),
    reauthMinutes: int(s.security_reauth_minutes, 5, 1, 120),
  };
}

export async function lockoutRules(db: Pool): Promise<{ attempts: number; minutes: number }> {
  const s = await getSettings(db);
  return { attempts: int(s.security_lockout_attempts, 5, 3, 20), minutes: int(s.security_lockout_minutes, 15, 1, 1440) };
}
