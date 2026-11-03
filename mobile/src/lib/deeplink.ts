export type TabName = "Home" | "Approvals" | "Stock" | "Orders" | "More";

export type DeepTarget =
  | { kind: "tab"; tab: TabName; params?: Record<string, unknown> }
  | { kind: "approval"; id: number }
  | { kind: "order"; id: number }
  | { kind: "alerts" };

/** Maps server deep links ("approvals/3", "orders?unpaid=1", "stock?alerts=1") to screens. */
export function parseDeepLink(link: string): DeepTarget | null {
  const [path = "", query = ""] = link.replace(/^\//, "").split("?");
  const [head = "", tail] = path.split("/");
  const q = new URLSearchParams(query);
  const id = tail !== undefined ? parseInt(tail, 10) : NaN;
  switch (head) {
    case "approvals":
      return Number.isFinite(id) ? { kind: "approval", id } : { kind: "tab", tab: "Approvals" };
    case "orders":
      if (Number.isFinite(id)) return { kind: "order", id };
      return {
        kind: "tab",
        tab: "Orders",
        params: q.get("unpaid") === "1" ? { unpaid: true, nonce: Date.now() } : undefined,
      };
    case "stock":
      return { kind: "tab", tab: "Stock" };
    case "alerts":
      return { kind: "alerts" };
    case "more":
      return { kind: "tab", tab: "More" };
    default:
      return null; // e.g. payments/unmatched arrives with v1.1
  }
}
