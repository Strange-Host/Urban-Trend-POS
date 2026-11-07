export type TabName = "Home" | "Dashboard" | "Approvals" | "Stock" | "Orders" | "More";

export type DeepTarget =
  | { kind: "tab"; tab: TabName; params?: Record<string, unknown> }
  | { kind: "approval"; id: string } // "<type>:<number>", e.g. "expense:12"
  | { kind: "order"; id: number }
  | { kind: "alerts" }
  | { kind: "route"; name: RouteName; params?: Record<string, unknown> };

/** Stack screens outside the tabs (the v1.1 screens). */
export type RouteName = "Catalog" | "Payments" | "StockTakes" | "StockTakeDetail" | "Couriers" | "Attendance" | "MyOrders" | "ConfirmOrder" | "MyLeads" | "LeadDetail" | "Returns";

/**
 * Where a record the server points at ("expense" 12, "order" 41, "lead" 7) opens in the app. Records the app has no screen for
 * (petty cash top-ups, stock transfers, cash sessions, security events, products waiting for approval) answer null, and the
 * caller says so instead of going nowhere.
 */
export function entityTarget(type: string, id: number): DeepTarget | null {
  switch (type) {
    // Approvals the app can show in full: the approval id is "<type>:<row id>".
    case "expense":
    case "requisition":
    case "duplicate_order":
      return { kind: "approval", id: `${type}:${id}` };
    // A void or refund request is one kind of "approval" row whose type the link does not say: open the list.
    case "approval":
    case "stock_adjustment":
      return { kind: "tab", tab: "Approvals" };
    case "order":
    case "order_return":
      return { kind: "order", id };
    case "lead":
      return { kind: "route", name: "LeadDetail", params: { id } };
    case "payment_notification":
    case "unmatched_payment":
    case "payment":
      return { kind: "route", name: "Payments" };
    case "stock_take":
      return { kind: "route", name: "StockTakeDetail", params: { id } };
    case "stock_count":
      return { kind: "route", name: "StockTakes" };
    case "courier":
    case "delivery_settlement":
      return { kind: "route", name: "Couriers" };
    case "staff_attendance":
      return { kind: "route", name: "Attendance" };
    case "product":
      return { kind: "route", name: "Catalog" };
    default:
      return null;
  }
}

/** Maps server deep links to screens: "<entity>:<id>" as the server sends, or the older "orders?unpaid=1" path form. */
export function parseDeepLink(link: string): DeepTarget | null {
  const ent = /^([a-z_]+):(\d+)$/.exec(link.trim());
  if (ent) return entityTarget(ent[1] as string, parseInt(ent[2] as string, 10));
  const [path = "", query = ""] = link.replace(/^\//, "").split("?");
  const [head = "", tail] = path.split("/");
  const q = new URLSearchParams(query);
  const id = tail !== undefined ? parseInt(tail, 10) : NaN;
  switch (head) {
    case "approvals":
      return tail && tail.includes(":") ? { kind: "approval", id: tail } : { kind: "tab", tab: "Approvals" };
    case "orders":
      if (Number.isFinite(id)) return { kind: "order", id };
      return {
        kind: "tab",
        tab: "Orders",
        params: q.get("unpaid") === "1" ? { unpaid: true, nonce: Date.now() } : undefined,
      };
    case "stock":
      return { kind: "tab", tab: "Stock" };
    case "payments":
      return { kind: "route", name: "Payments" };
    case "catalog":
      return { kind: "route", name: "Catalog" };
    case "stock-takes":
      return Number.isFinite(id) ? { kind: "route", name: "StockTakeDetail", params: { id } } : { kind: "route", name: "StockTakes" };
    case "couriers":
      return { kind: "route", name: "Couriers" };
    case "attendance":
      return { kind: "route", name: "Attendance" };
    case "telesales":
      return Number.isFinite(id) ? { kind: "route", name: "ConfirmOrder", params: { id } } : { kind: "route", name: "MyOrders" };
    case "leads":
      return Number.isFinite(id) ? { kind: "route", name: "LeadDetail", params: { id } } : { kind: "route", name: "MyLeads" };
    case "returns":
      return { kind: "route", name: "Returns" };
    case "dashboard":
    case "analytics":
      return { kind: "tab", tab: "Dashboard" };
    case "alerts":
      return { kind: "alerts" };
    case "more":
      return { kind: "tab", tab: "More" };
    default:
      return null;
  }
}
