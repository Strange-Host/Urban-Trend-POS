// What each role may do. This is the one place to read or change it. A route names the permission it needs and nothing else.
// Admin-only on purpose: approving and paying payroll, managing users, changing pay profiles' commission plans.
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

export const can = (role: Role, permission: Permission): boolean => MATRIX[role].has(permission);
export const permissionsOf = (role: Role): Permission[] => [...MATRIX[role]].sort();
