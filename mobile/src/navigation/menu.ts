import type { TabName } from "../lib/deeplink";

// The website's menu, in the same order and groups. Items without a `screen` are pages the web app has that the
// phone app does not have yet: they show greyed out with "Soon" and start working the moment a screen is named here.
export interface MenuItem {
  label: string;
  icon: string;
  screen?: TabName;
  perm?: string | string[];
}

export const PINNED_TOP: MenuItem[] = [
  { label: "Home", icon: "⌂", screen: "Home" },
  { label: "Dashboard", icon: "▲", screen: "Dashboard", perm: "reports.view" },
];

export const GROUPS: { id: string; label: string; items: MenuItem[] }[] = [
  {
    id: "sell",
    label: "Sell",
    items: [
      { label: "Orders", icon: "⊞", screen: "Orders" },
      { label: "Approvals", icon: "✓", screen: "Approvals" },
      { label: "Leads", icon: "☍" },
      { label: "Sales history", icon: "☰" },
    ],
  },
  {
    id: "stock",
    label: "Stock",
    items: [
      { label: "Stock control", icon: "⇅", screen: "Stock" },
      { label: "Catalog", icon: "▤" },
    ],
  },
  {
    id: "money",
    label: "Money",
    items: [
      { label: "Money at risk", icon: "⚑" },
      { label: "Finance", icon: "◈" },
      { label: "Reconciliation", icon: "⇌" },
    ],
  },
];
