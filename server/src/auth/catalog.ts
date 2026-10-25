import type { Permission, Role } from './permissions.js';

// The delegable permissions, under the names the legacy "Staff access" screen already uses. Each entry says which engine
// permissions it controls, so one toggle in the editor really changes what the new server allows. `roles` is the default
// the legacy screen showed; it equals the engine's role default for every permission the entry grants.
//
// Deliberately NOT here (role-only): settings, backups, gateway and SMS credentials, staff create/edit/delete, onboarding,
// income sources, telesales rebalancing, owner write-off decisions, payroll approval and payment.
export interface CatalogEntry { key: string; group: string; label: string; roles: readonly Role[]; grants: readonly Permission[] }

export const CATALOG: readonly CatalogEntry[] = [
  { key: 'reports.view',           group: 'Reports',   label: 'View reports and dashboard figures',               roles: ['admin', 'manager'], grants: ['reports.view'] },
  { key: 'payroll.view',           group: 'Team',      label: 'View payroll and commission',                       roles: ['admin', 'manager'], grants: ['payroll.view'] },
  { key: 'staff.view',             group: 'Team',      label: 'View the staff list',                               roles: ['admin', 'manager'], grants: ['staff.view'] },
  { key: 'attendance.view',        group: 'Team',      label: "View today's attendance and absences",              roles: ['admin', 'manager'], grants: ['attendance.view'] },
  { key: 'expenses.manage',        group: 'Money',     label: 'Record and edit expenses',                          roles: ['admin', 'manager'], grants: ['expenses.manage'] },
  { key: 'payments.manage',        group: 'Money',     label: 'Record and refund payments',                        roles: ['admin', 'manager'], grants: ['payments.manage'] },
  { key: 'payments.reconcile',     group: 'Money',     label: 'Match unmatched payments to orders',                roles: ['admin', 'manager'], grants: ['payments.match'] },
  { key: 'requisitions.approve',   group: 'Money',     label: 'Approve or reject requisitions',                    roles: ['admin', 'manager'], grants: ['requisitions.approve'] },
  { key: 'cashsessions.view',      group: 'Money',     label: "View other staff's cash sessions",                  roles: ['admin', 'manager'], grants: ['cashsessions.view'] },
  { key: 'sales.void',             group: 'Sales',     label: 'Void a completed sale',                             roles: ['admin', 'manager'], grants: ['pos.approve'] },
  { key: 'orders.pull_online',     group: 'Orders',    label: 'Pull to-ship orders from Shopify / WooCommerce',    roles: ['admin', 'manager'], grants: ['orders.pull_online'] },
  { key: 'orders.inspect',         group: 'Orders',    label: 'Inspect returned parcels',                          roles: ['admin', 'manager'], grants: ['orders.inspect'] },
  { key: 'orders.resolve_dispute', group: 'Orders',    label: 'Resolve payment disputes',                          roles: ['admin', 'manager'], grants: ['orders.resolve_dispute'] },
  { key: 'products.manage',        group: 'Stock',     label: 'Create, edit and delete products and categories',   roles: ['admin', 'manager'], grants: ['catalog.manage'] },
  { key: 'inventory.adjust',       group: 'Stock',     label: 'Adjust stock and view the stock check',             roles: ['admin', 'manager'], grants: ['stock.adjust'] },
  { key: 'shopify.sync',           group: 'Stock',     label: 'Use Shopify / WooCommerce sync',                    roles: ['admin', 'manager'], grants: ['shopify.sync'] },
  { key: 'sms.view',               group: 'Messaging', label: 'View SMS delivery and retry failed messages',       roles: ['admin', 'manager'], grants: ['sms.view'] },
  { key: 'couriers.manage',        group: 'Orders',    label: 'Add and edit couriers',                             roles: ['admin', 'manager'], grants: ['couriers.manage'] },
  { key: 'leads.intake_routes',    group: 'Sales',     label: 'Manage web-form lead routing',                      roles: ['admin', 'manager'], grants: ['leads.intake_routes'] },
];

export const CATALOG_KEYS: ReadonlySet<string> = new Set(CATALOG.map((e) => e.key));
export const catalogDefault = (role: Role, key: string): boolean => CATALOG.find((e) => e.key === key)?.roles.includes(role) ?? false;
