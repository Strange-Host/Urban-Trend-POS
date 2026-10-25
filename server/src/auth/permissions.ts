// What each role may do. This is the one place to read or change it. A route names the permission it needs and nothing else.
// Admin-only on purpose: approving and paying payroll, managing users, changing pay profiles' commission plans.
import { CATALOG } from './catalog.js';

export type Role = 'admin' | 'manager' | 'cashier';
export const ROLES: readonly Role[] = ['admin', 'manager', 'cashier'];

const CASHIER = [
  'pos.sell', 'till.operate', 'orders.view', 'orders.create', 'attendance.own',
  'catalog.view', 'stock.view', 'customers.view', 'customers.manage', 'leads.view', 'leads.manage',
] as const;

const MANAGER = [
  ...CASHIER,
  'orders.manage', 'payments.match', 'couriers.view', 'couriers.manage', 'courier_costs.approve',
  'till.signoff', 'pos.approve', 'reports.view', 'audit.view', 'atrisk.view',
  'payroll.view', 'payroll.manage', 'attendance.manage',
  'catalog.manage', 'stock.receive', 'stock.adjust', 'customers.flag', 'leads.assign',
  // Added for the legacy screens (phase B). The routes that use them arrive with their page in phase D; until then they only
  // exist so the "Staff access" editor can show and store them.
  'staff.view', 'attendance.view', 'expenses.manage', 'payments.manage', 'requisitions.approve', 'cashsessions.view',
  'orders.pull_online', 'orders.inspect', 'orders.resolve_dispute', 'shopify.sync', 'sms.view', 'leads.intake_routes',
] as const;

const ADMIN = [
  ...MANAGER,
  'payroll.approve', 'payroll.pay', 'payroll.rates', 'courier_payouts.pay', 'users.manage', 'policy.manage',
] as const;

export type Permission = (typeof ADMIN)[number];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  cashier: new Set<Permission>(CASHIER),
  manager: new Set<Permission>(MANAGER),
  admin: new Set<Permission>(ADMIN),
};

/** What a ROLE allows by default. Use canUser for a person: it also applies their individual overrides. */
export const can = (role: Role, permission: Permission): boolean => MATRIX[role].has(permission);
export const permissionsOf = (role: Role): Permission[] => [...MATRIX[role]].sort();

/** The person as far as permission checks go. `overrides` is keyed by the editor's key (see catalog.ts). */
export interface Permitted { role: Role; overrides?: Readonly<Record<string, boolean>> }

/**
 * Admin: always everything. Everyone else: an explicit override on the editor key that controls this permission wins,
 * otherwise the role default. A permission no editor key controls (payroll approval, user management...) is role-only on purpose:
 * a permission you can delegate is a permission you can lose control of.
 */
export function canUser(user: Permitted, permission: Permission): boolean {
  if (user.role === 'admin') return can('admin', permission);
  const key = EDITOR_KEY_FOR.get(permission);
  if (key !== undefined && user.overrides && Object.prototype.hasOwnProperty.call(user.overrides, key)) return user.overrides[key]!;
  return can(user.role, permission);
}

/** Every permission this person has, overrides included. */
export const permissionsOfUser = (user: Permitted): Permission[] => [...MATRIX.admin].filter((p) => canUser(user, p)).sort();

const EDITOR_KEY_FOR = new Map<Permission, string>(CATALOG.flatMap((e) => e.grants.map((g) => [g, e.key] as const)));
