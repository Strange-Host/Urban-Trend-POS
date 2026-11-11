// The navigation map: every page a person can go to, who may see it, and how it is grouped.
// Shared by the shell (Layout.jsx, shell/) and the Ctrl+K palette (CommandPalette.jsx). `workspace` places each page in one of
// the five workspaces (or Settings).
import {
  ChartColumn, ClipboardCheck, GitCompareArrows, History, House, LayoutDashboard, Package, RefreshCw, ScrollText, Settings, ShoppingCart, Tags, TriangleAlert, UserCog, Users, Wallet, Warehouse,
} from 'lucide-react';

// Grouped by "what am I doing right now", not by which backend module a
// page belongs to — that's why Attendance sits under Team next to Payroll
// (attendance data is literally what drives payroll deductions) rather
// than under an Operations bucket, and why Reconciliation sits under Money
// next to Finance rather than next to Orders.
//
// Terminal and Dashboard are deliberately ungrouped and pinned to the top:
// they're where a shift starts, and burying either one behind a disclosure
// triangle to save two lines would be a bad trade.
export const PINNED_TOP = [
  // The cashier's Start screen (pages/Start.jsx). `uncounted`: a landing page rather than another destination, so it does not
  // count toward FLAT_BELOW and a cashier keeps the flat rail.
  { to: '/start', workspace: 'sell', label: 'Start', icon: House, keywords: 'home start shift tiles what are you doing', roles: ['cashier'], uncounted: true },
  { to: '/terminal', workspace: 'sell', label: 'Terminal', icon: ShoppingCart, keywords: 'till pos checkout register sell sale cashier', roles: ['admin', 'manager', 'cashier'] },
  { to: '/dashboard', workspace: 'today', label: 'Dashboard', icon: LayoutDashboard, keywords: 'home overview kpi', roles: ['admin', 'manager'], perm: 'reports.view' },
  { to: '/reports', workspace: 'money', label: 'Reports', icon: ChartColumn, keywords: 'report profit loss p&l vat discount export', roles: ['admin', 'manager'], perm: 'reports.view' },
];

export const GROUPS = [
  {
    id: 'sell',
    label: 'Sell',
    items: [
      { to: '/orders', workspace: 'sell', label: 'Orders', icon: Package, keywords: 'online dispatch delivery courier parcel', roles: ['admin', 'manager', 'cashier'] },
      { to: '/leads', workspace: 'sell', label: 'Leads', icon: Users, keywords: 'enquiry customer crm followup', roles: ['admin', 'manager', 'cashier'] },
      { to: '/sales', workspace: 'sell', label: 'Sales history', icon: History, keywords: 'receipts history transactions invoice', roles: ['admin', 'manager', 'cashier'] },
      { to: '/approvals', workspace: 'sell', label: 'Approvals', icon: ClipboardCheck, keywords: 'void refund approve reject', roles: ['admin', 'manager', 'cashier'], perm: ['approvals.review', 'sales.void_request', 'payments.refund_request'] },
    ],
  },
  {
    id: 'stock',
    label: 'Stock',
    items: [
      { to: '/catalog', workspace: 'stock', label: 'Catalog', icon: Tags, keywords: 'products categories items price', roles: ['admin', 'manager', 'store'], perm: ['products.manage', 'products.propose'] },
      { to: '/stock', workspace: 'stock', label: 'Stock control', icon: Warehouse, keywords: 'inventory receive transfer count batch expiry', roles: ['admin', 'manager', 'store'], perm: ['stock.receive', 'stock.transfer', 'stock.count'] },
      { to: '/shopify-sync', workspace: 'stock', label: 'Shopify sync', icon: RefreshCw, keywords: 'woocommerce online store import', roles: ['admin', 'manager'], perm: 'shopify.sync' },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      { to: '/money-at-risk', workspace: 'money', label: 'Money at risk', icon: TriangleAlert, keywords: 'unpaid overdue variance owed', roles: ['admin', 'manager'], perm: 'atrisk.view' },
      { to: '/finance', workspace: 'money', label: 'Finance', icon: Wallet, keywords: 'expenses payments income cash', roles: ['admin', 'manager'] },
      { to: '/reconciliation', workspace: 'money', label: 'Reconciliation', icon: GitCompareArrows, keywords: 'mpesa m-pesa match paybill payments', roles: ['admin', 'manager'], perm: 'payments.reconcile' },
    ],
  },
  {
    id: 'team',
    label: 'Team',
    items: [
      { to: '/staff', workspace: 'team', label: 'Staff', icon: UserCog, keywords: 'users accounts employees permissions', roles: ['admin'] },
      { to: '/staff-logs', workspace: 'team', label: 'Activity log', icon: ScrollText, keywords: 'audit history who did', roles: ['admin'] },
    ],
  },
];

export const PINNED_BOTTOM = [
  { to: '/settings', workspace: 'settings', label: 'Settings', icon: Settings, keywords: 'configuration branches printer messaging sms system', roles: ['admin'] },
];


export const ALL_ITEMS = [
  ...PINNED_TOP.map((i) => ({ ...i, group: null })),
  ...GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label }))),
  ...PINNED_BOTTOM.map((i) => ({ ...i, group: null })),
];

/**
 * The items this person may see: an optional module must be switched on, and the item's permission (or, without one,
 * its role list) must allow them. One place so the rail and the Ctrl+K palette can never disagree.
 */
export function filterVisible(items, { hasRole, can, modules }) {
  return items
    .filter((i) => !i.module || modules[i.module])
    .filter((i) => (i.perm ? (Array.isArray(i.perm) ? i.perm.some((p) => can(p)) : can(i.perm)) : hasRole(...i.roles)));
}

/* ---------------------- Workspaces ---------------------- */

// Roles with fewer destinations than this get a flat rail (one item per page) instead of the workspace rail.
export const FLAT_BELOW = 8;

// The workspaces shown on the rail, in order. Settings is not one of them: it sits in the rail's bottom stack.
export const WORKSPACES = [
  { id: 'today', label: 'Today', icon: LayoutDashboard },
  { id: 'sell', label: 'Sell', icon: ShoppingCart },
  { id: 'stock', label: 'Stock', icon: Warehouse },
  { id: 'money', label: 'Money', icon: Wallet },
  { id: 'team', label: 'Team', icon: Users },
];

// The order pages appear in within a workspace (and in the flat rail). The first one a person can see is where the
// workspace's rail item takes them.
export const ROUTE_ORDER = [
  '/start', '/dashboard',
  '/terminal', '/orders', '/leads', '/sales', '/approvals',
  '/catalog', '/stock', '/shopify-sync',
  '/finance', '/reconciliation', '/money-at-risk', '/reports',
  '/staff', '/staff-logs',
  '/settings',
];

export function byRouteOrder(items) {
  const rank = (to) => { const i = ROUTE_ORDER.indexOf(to); return i === -1 ? ROUTE_ORDER.length : i; };
  return [...items].sort((a, b) => rank(a.to) - rank(b.to));
}

/**
 * Where each role starts: the storekeeper has no till so opens on the catalog, admins and managers who can see reports open
 * on the dashboard, everyone else on the till. App.jsx's Home() follows this, so the landing page and the rail's logo agree.
 */
export function homeRouteFor(role, can) {
  if (role === 'store') return '/catalog';
  if ((role === 'admin' || role === 'manager') && can('reports.view')) return '/dashboard';
  return '/terminal';
}
