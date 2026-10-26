import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { audit } from '../pos/audit.js';
import { ROLES, type Role } from './permissions.js';
import { getSettings, setSettings } from './settings.js';
import type { AuthUser } from './types.js';

// The security rules an admin can change from the Security page: sign-in lockout, lock and sign-out times per role, session
// maximums, how long "confirm it's you" stays good, and the limits that raise an alert. Stored under the legacy key names, so the
// same screen works unchanged. The session code reads these through settings.ts; this file is only the editor's view of them.

const ROLE_DEFAULTS: Record<Role, { lockMinutes: number; idleSignOutMinutes: number; maxHours: number }> = {
  cashier: { lockMinutes: 5, idleSignOutMinutes: 30, maxHours: 12 },
  manager: { lockMinutes: 10, idleSignOutMinutes: 60, maxHours: 168 },
  admin: { lockMinutes: 10, idleSignOutMinutes: 30, maxHours: 24 },
};

const num = (v: string | undefined, dflt: number) => { const n = Number.parseInt(v ?? '', 10); return Number.isFinite(n) ? n : dflt; };

export interface SecurityPolicy {
  lockout: { attempts: number; minutes: number };
  roles: Record<Role, { lockMinutes: number; idleSignOutMinutes: number; maxHours: number }>;
  unrememberedMaxHours: number;
  reauthMinutes: number;
  /** Stored for the alerts that arrive with the Security page; whole shillings, units and percent, as the screen shows them. */
  alerts: { refundKes: number; stockUnits: number; pricePercent: number };
}

export async function currentPolicy(db: Pool): Promise<SecurityPolicy> {
  const s = await getSettings(db);
  return {
    lockout: { attempts: num(s.security_lockout_attempts, 5), minutes: num(s.security_lockout_minutes, 15) },
    roles: Object.fromEntries(ROLES.map((r) => [r, {
      lockMinutes: num(s[`security_lock_minutes_${r}`], ROLE_DEFAULTS[r].lockMinutes),
      idleSignOutMinutes: num(s[`security_idle_signout_minutes_${r}`], ROLE_DEFAULTS[r].idleSignOutMinutes),
      maxHours: num(s[`security_max_session_hours_${r}`], ROLE_DEFAULTS[r].maxHours),
    }])) as SecurityPolicy['roles'],
    unrememberedMaxHours: num(s.security_unremembered_max_hours, 12),
    reauthMinutes: num(s.security_reauth_minutes, 5),
    alerts: { refundKes: num(s.security_alert_refund_kes, 3000), stockUnits: num(s.security_alert_stock_units, 25), pricePercent: num(s.security_alert_price_percent, 15) },
  };
}

const whole = (v: unknown, label: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(422, 'VALIDATION', `${label} must be a whole number from ${min} to ${max}.`);
  return n;
};

export interface PolicyPatch {
  lockout?: Partial<SecurityPolicy['lockout']>;
  roles?: Partial<Record<Role, Partial<SecurityPolicy['roles'][Role]>>>;
  unrememberedMaxHours?: number;
  reauthMinutes?: number;
  alerts?: Partial<SecurityPolicy['alerts']>;
}

/** Any part of the policy, validated as a whole before anything is saved. */
export async function updatePolicy(pool: Pool, patch: PolicyPatch, actor: AuthUser): Promise<SecurityPolicy> {
  const cur = await currentPolicy(pool);
  const next = {
    lockout: { ...cur.lockout, ...patch.lockout },
    roles: Object.fromEntries(ROLES.map((r) => [r, { ...cur.roles[r], ...patch.roles?.[r] }])) as SecurityPolicy['roles'],
    unrememberedMaxHours: patch.unrememberedMaxHours ?? cur.unrememberedMaxHours,
    reauthMinutes: patch.reauthMinutes ?? cur.reauthMinutes,
    alerts: { ...cur.alerts, ...patch.alerts },
  };
  const updates: Record<string, number> = {
    security_lockout_attempts: whole(next.lockout.attempts, 'Wrong attempts before locking', 3, 20),
    security_lockout_minutes: whole(next.lockout.minutes, 'Lock time (minutes)', 1, 1440),
    security_unremembered_max_hours: whole(next.unrememberedMaxHours, 'Longest sign-in without "remember this device" (hours)', 1, 720),
    security_reauth_minutes: whole(next.reauthMinutes, 'Password re-check window (minutes)', 1, 60),
    security_alert_refund_kes: whole(next.alerts.refundKes, 'Refund alert amount (KES)', 0, 100_000_000),
    security_alert_stock_units: whole(next.alerts.stockUnits, 'Stock adjustment alert (units)', 1, 1_000_000),
    security_alert_price_percent: whole(next.alerts.pricePercent, 'Price change alert (%)', 1, 100),
  };
  for (const r of ROLES) {
    const p = next.roles[r];
    const lock = whole(p.lockMinutes, `${r}: lock screen after (minutes)`, 1, 240);
    const idle = whole(p.idleSignOutMinutes, `${r}: sign out after (minutes)`, 2, 10080);
    const max = whole(p.maxHours, `${r}: longest sign-in (hours)`, 1, 720);
    if (idle <= lock) throw new HttpError(422, 'VALIDATION', `${r}: signing out must come after the screen locks (sign-out minutes must be more than lock minutes).`);
    updates[`security_lock_minutes_${r}`] = lock;
    updates[`security_idle_signout_minutes_${r}`] = idle;
    updates[`security_max_session_hours_${r}`] = max;
  }
  await withTransaction(pool, async (c) => {
    await setSettings(c, Object.fromEntries(Object.entries(updates).map(([k, v]) => [k, String(v)])), actor.username);
    await audit(c, { actor: actor.username, role: actor.role, action: 'security_policy_changed', entityType: 'settings', risk: 1, details: { before: cur, after: next } });
  });
  return currentPolicy(pool);
}
