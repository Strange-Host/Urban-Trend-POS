// The navigation map: every page a person can go to, who may see it, and how it is grouped.
// Shared by the sidebar (Layout.jsx) and the Ctrl+K palette (CommandPalette.jsx).
import {
  Banknote, ChartColumn, ClipboardCheck, Clock, GitCompareArrows, History, LayoutDashboard, Package, ReceiptText,
  RefreshCw, ScrollText, Settings, ShoppingCart, Tags, TriangleAlert, UserCog, UserPlus, Users, Wallet, Warehouse,
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
  { to: '/terminal', label: 'Terminal', icon: ShoppingCart, keywords: 'till pos checkout register sell sale cashier', roles: ['admin', 'manager', 'cashier'] },
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, keywords: 'home overview kpi', roles: ['admin', 'manager'], perm: 'reports.view' },
  { to: '/reports', label: 'Reports', icon: ChartColumn, keywords: 'report profit loss p&l vat discount export', roles: ['admin', 'manager'], perm: 'reports.view' },
];

export const GROUPS = [
  {
    id: 'sell',
    label: 'Sell',
    items: [
      { to: '/orders', label: 'Orders', icon: Package, keywords: 'online dispatch delivery courier parcel', roles: ['admin', 'manager', 'cashier'] },
      { to: '/leads', label: 'Leads', icon: Users, keywords: 'enquiry customer crm followup', roles: ['admin', 'manager', 'cashier'] },
      { to: '/sales', label: 'Sales history', icon: History, keywords: 'receipts history transactions invoice', roles: ['admin', 'manager', 'cashier'] },
      { to: '/approvals', label: 'Approvals', icon: ClipboardCheck, keywords: 'void refund approve reject', roles: ['admin', 'manager', 'cashier'], perm: ['approvals.review', 'sales.void_request', 'payments.refund_request'] },
    ],
  },
  {
    id: 'stock',
    label: 'Stock',
    items: [
      { to: '/catalog', label: 'Catalog', icon: Tags, keywords: 'products categories items price', roles: ['admin', 'manager', 'store'], perm: ['products.manage', 'products.propose'] },
      { to: '/stock', label: 'Stock control', icon: Warehouse, keywords: 'inventory receive transfer count batch expiry', roles: ['admin', 'manager', 'store'], perm: ['stock.receive', 'stock.transfer', 'stock.count'] },
      { to: '/shopify-sync', label: 'Shopify sync', icon: RefreshCw, keywords: 'woocommerce online store import', roles: ['admin', 'manager'], perm: 'shopify.sync' },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    items: [
      { to: '/money-at-risk', label: 'Money at risk', icon: TriangleAlert, keywords: 'unpaid overdue variance owed', roles: ['admin', 'manager'], perm: 'atrisk.view' },
      { to: '/finance', label: 'Finance', icon: Wallet, keywords: 'expenses payments income cash', roles: ['admin', 'manager'] },
      { to: '/reconciliation', label: 'Reconciliation', icon: GitCompareArrows, keywords: 'mpesa m-pesa match paybill payments', roles: ['admin', 'manager'], perm: 'payments.reconcile' },
      { to: '/requisitions', label: 'Requisitions', icon: ReceiptText, keywords: 'request purchase spend', roles: ['admin', 'manager', 'cashier'], module: 'hr' },
    ],
  },
  {
    id: 'team',
    label: 'Team',
    items: [
      { to: '/attendance', label: 'Attendance', icon: Clock, keywords: 'clock shift roster', roles: ['admin', 'manager', 'cashier'], module: 'hr' },
      { to: '/payroll', label: 'Payroll', icon: Banknote, keywords: 'salary wages payslip', roles: ['admin', 'manager'], perm: 'payroll.view', module: 'hr' },
      { to: '/staff', label: 'Staff', icon: UserCog, keywords: 'users accounts employees permissions', roles: ['admin'] },
      { to: '/employees', label: 'Onboarding', icon: UserPlus, keywords: 'hire new employee onboarding', roles: ['admin'], module: 'hr' },
      { to: '/staff-logs', label: 'Activity log', icon: ScrollText, keywords: 'audit history who did', roles: ['admin'] },
    ],
  },
];

export const PINNED_BOTTOM = [
  { to: '/settings', label: 'Settings', icon: Settings, keywords: 'configuration branches printer messaging sms system', roles: ['admin'] },
];


export const ALL_ITEMS = [
  ...PINNED_TOP.map((i) => ({ ...i, group: null })),
  ...GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.label }))),
  ...PINNED_BOTTOM.map((i) => ({ ...i, group: null })),
];

/**
 * The items this person may see: an optional module must be switched on, and the item's permission (or, without one,
 * its role list) must allow them. One place so the sidebar and the Ctrl+K palette can never disagree.
 */
export function filterVisible(items, { hasRole, can, modules }) {
  return items
    .filter((i) => !i.module || modules[i.module])
    .filter((i) => (i.perm ? (Array.isArray(i.perm) ? i.perm.some((p) => can(p)) : can(i.perm)) : hasRole(...i.roles)));
}
