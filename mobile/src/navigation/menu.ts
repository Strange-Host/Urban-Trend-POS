import type { RouteName, TabName } from "../lib/deeplink";

// The website's menu, in the same order and groups. Items without a `screen` are pages the web app has that the
// phone app does not have yet: they show greyed out with "Soon" and start working the moment a screen is named here.
export interface MenuItem {
  label: string;
  icon: string;
  screen?: TabName;
  /** A pushed (stack) screen instead of a tab. */
  route?: RouteName;
  perm?: string | string[];
}

// The same keys the server asks for (GET /approvals, GET /stock/lookup): a screen the server would answer 403 is not offered.
export const APPROVER_PERMS = ["approvals.review", "expenses.approve", "requisitions.approve", "inventory.approve_adjust", "orders.approve_duplicate"];
export const STOCK_LOOKUP_PERMS = ["inventory.adjust", "stock.review", "stock.receive"];

export const PINNED_TOP: MenuItem[] = [
  { label: "Home", icon: "⌂", screen: "Home" },
  { label: "Dashboard", icon: "▲", screen: "Dashboard", perm: "reports.view" },
];

export const GROUPS: { id: string; label: string; items: MenuItem[] }[] = [
  {
    id: "sell",
    label: "Sell",
    items: [
      { label: "Orders", icon: "⊞", screen: "Orders", perm: "orders.view" },
      { label: "Approvals", icon: "✓", screen: "Approvals", perm: APPROVER_PERMS },
      { label: "My orders", icon: "☎", route: "MyOrders", perm: "telesales.work" },
      { label: "Leads", icon: "☍", route: "MyLeads", perm: "leads.work" },
      { label: "Returns", icon: "↩", route: "Returns", perm: "returns.receive" },
      { label: "Sales history", icon: "☰" },
    ],
  },
  {
    id: "stock",
    label: "Stock",
    items: [
      { label: "Stock control", icon: "⇅", screen: "Stock", perm: STOCK_LOOKUP_PERMS },
      { label: "Catalog", icon: "▤", route: "Catalog", perm: "products.manage" },
      { label: "Stock-take", icon: "☑", route: "StockTakes", perm: "stock.count" },
    ],
  },
  {
    id: "money",
    label: "Money",
    items: [
      { label: "Money at risk", icon: "⚑" },
      { label: "Finance", icon: "◈" },
      { label: "Reconciliation", icon: "⇌", route: "Payments", perm: "payments.reconcile" },
      { label: "Courier remittance", icon: "⇄", route: "Couriers", perm: "couriers.settle" },
    ],
  },
  {
    id: "staff",
    label: "Staff",
    items: [{ label: "Attendance", icon: "◷", route: "Attendance" }],
  },
];
