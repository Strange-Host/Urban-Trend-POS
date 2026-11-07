import { ApiError } from "./errors";
import { createHttpV11 } from "./httpV11";
import { createHttpV2 } from "./httpV2";
import { V11_ERROR_CODES } from "./typesV11";
import { V2_ERROR_CODES } from "./typesV2";
import { rangeWindow } from "../lib/analytics";
import type {
  Analytics,
  AnalyticsRange,
  AnalyticsSummary,
  Api,
  ApiErrorBody,
  ApiErrorCode,
  AdjustRequest,
  AdjustResult,
  AppNotification,
  AppVersionInfo,
  Approval,
  ApprovalDecisionResult,
  ApprovalStatus,
  HomeAttention,
  HomeSummary,
  MobileLoginResponse,
  OrderDetail,
  OrderFilter,
  OrdersPage,
  Paginated,
  StockItem,
  TokenPair,
} from "./types";

const KNOWN: ApiErrorCode[] = [
  "INVALID_CREDENTIALS",
  "TOKEN_EXPIRED",
  "REFRESH_INVALID",
  "DEVICE_REVOKED",
  "FORBIDDEN",
  ...V2_ERROR_CODES,
  ...V2_ERROR_CODES, // v2: DUPLICATE_PHONE, NOT_AWAITING, NOT_RETURNABLE, ...
  ...V11_ERROR_CODES, // the v1.1 screens branch on these (REASON_REQUIRED, PREVIEW_STALE, ALREADY_MATCHED, ...)
];

async function call<T>(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; prefix?: string } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${opts.prefix ?? "/api/v1"}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError("NETWORK", "No connection", 0);
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const body = json as Partial<ApiErrorBody> | null;
    const raw = body?.error?.code as ApiErrorCode | undefined;
    const code = raw && KNOWN.includes(raw) ? raw : "UNKNOWN";
    throw new ApiError(code, body?.error?.message ?? `HTTP ${res.status}`, res.status, (json as { details?: unknown } | null)?.details);
  }
  return json as T;
}

// Errors that mean "the whole request is unusable" (offline, session ended). Anything else on one report just
// leaves that card out of the dashboard instead of blanking it.
const SESSION_LEVEL = new Set<string>(["NETWORK", "TOKEN_EXPIRED", "REFRESH_INVALID", "DEVICE_REVOKED"]);

// The dashboard reads the same report endpoints as the web Dashboard (envelope: { data }), in parallel.
async function loadAnalytics(base: string, token: string, range: AnalyticsRange): Promise<Analytics> {
  const w = rangeWindow(range);
  const rep = async <T,>(path: string, params: Record<string, string | undefined> = {}) => {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
      .join("&");
    const r = await call<{ data: T }>(base, "GET", `${path}${qs ? `?${qs}` : ""}`, { token, prefix: "/api" });
    return r.data;
  };

  type RawSummary = { transaction_count: number; revenue: number; avg_basket: number };
  const toSummary = (r: RawSummary): AnalyticsSummary => ({
    revenueCents: r.revenue,
    transactions: r.transaction_count,
    avgBasketCents: Math.round(r.avg_basket),
  });

  const [summary, previous, inventory, byChannel, trend, methods, top, overview, alerts] = await Promise.allSettled([
    rep<RawSummary>("/reports/sales-summary", { from: w.from }),
    w.prevFrom && w.prevTo
      ? rep<RawSummary>("/reports/sales-summary", { from: w.prevFrom, to: w.prevTo })
      : Promise.resolve(null),
    rep<{ total_retail_value: number }>("/reports/inventory-value"),
    rep<
      {
        source_type: string;
        channel_name: string;
        platform: string | null;
        transaction_count: number;
        revenue: number;
        avg_basket: number;
      }[]
    >("/reports/sales-by-channel", { from: w.from }),
    rep<{ day: string; source_type: string; revenue: number }[]>("/reports/sales-trend", {
      from: range === "all" ? undefined : w.from,
    }),
    rep<{ method: string; total_amount: number; payment_count: number }[]>("/reports/payment-methods", { from: w.from }),
    rep<Record<string, { id: number; name: string; units_sold: number; revenue: number }[]>>(
      "/reports/top-products-by-channel",
      { from: w.from, limit: "6" },
    ),
    rep<{
      date: string;
      salesToday: {
        posRevenue: number;
        onlineRevenue: number;
        combinedRevenue: number;
        posTransactionCount: number;
        onlineOrderCount: number;
      };
      cashCollectedToday: number;
      orderStatusBreakdown: { status: string; count: number; outstanding_value: number }[];
      unpaidParcelsByCourier: { courier_type: string; parcel_count: number; capital_tied_up: number }[];
      stockOnHand: { total_cost_value: number; total_units: number };
      lowStockCount: number;
    }>("/reports/dashboard-overview"),
    rep<{
      expiry_alert_days: number;
      counts: {
        expiring: number;
        expired: number;
        recalled: number;
        damaged_units_30d: number;
        damaged_returns_awaiting_decision: number;
      };
    }>("/stock/alerts"),
  ]);

  for (const r of [summary, previous, inventory, byChannel, trend, methods, top, overview, alerts]) {
    if (r.status === "rejected" && r.reason instanceof ApiError && SESSION_LEVEL.has(r.reason.code)) throw r.reason;
  }
  // Without the headline numbers there is no dashboard; every other card may be missing.
  if (summary.status === "rejected") throw summary.reason;
  const ok = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);

  const trendRows = ok(trend) ?? [];
  const byDay = new Map<string, Record<string, number>>();
  for (const r of trendRows) {
    const m = byDay.get(r.day) ?? {};
    m[r.source_type] = (m[r.source_type] ?? 0) + r.revenue;
    byDay.set(r.day, m);
  }

  const ov = ok(overview);
  const al = ok(alerts);
  const prevRaw = ok(previous);

  return {
    range,
    generatedAt: new Date().toISOString(),
    summary: toSummary(summary.value),
    previous: prevRaw ? toSummary(prevRaw) : null,
    inventoryRetailValueCents: ok(inventory)?.total_retail_value ?? null,
    channels: (ok(byChannel) ?? []).map((r) => ({
      sourceType: r.source_type,
      channelName: r.channel_name,
      platform: r.platform,
      transactions: r.transaction_count,
      revenueCents: r.revenue,
      avgBasketCents: Math.round(r.avg_basket),
    })),
    trend: [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, bySource]) => ({ day, bySource })),
    paymentMethods: (ok(methods) ?? []).map((r) => ({ method: r.method, totalCents: r.total_amount, count: r.payment_count })),
    topByChannel: Object.fromEntries(
      Object.entries(ok(top) ?? {}).map(([ch, list]) => [
        ch,
        list.map((p) => ({ id: p.id, name: p.name, unitsSold: p.units_sold, revenueCents: p.revenue })),
      ]),
    ),
    overview: ov
      ? {
          date: ov.date,
          posRevenueCents: ov.salesToday.posRevenue,
          onlineRevenueCents: ov.salesToday.onlineRevenue,
          combinedRevenueCents: ov.salesToday.combinedRevenue,
          posTransactions: ov.salesToday.posTransactionCount,
          onlineOrders: ov.salesToday.onlineOrderCount,
          cashCollectedCents: ov.cashCollectedToday,
          lowStockCount: ov.lowStockCount,
          unpaidParcels: ov.unpaidParcelsByCourier.map((c) => ({
            courier: c.courier_type,
            count: c.parcel_count,
            owedCents: c.capital_tied_up,
          })),
          orderStatus: ov.orderStatusBreakdown.map((o) => ({
            status: o.status,
            count: o.count,
            outstandingCents: o.outstanding_value,
          })),
          stockCostValueCents: ov.stockOnHand.total_cost_value,
          stockUnits: ov.stockOnHand.total_units,
        }
      : null,
    stockAlerts: al
      ? {
          expiring: al.counts.expiring,
          expired: al.counts.expired,
          recalled: al.counts.recalled,
          damaged: al.counts.damaged_units_30d + al.counts.damaged_returns_awaiting_decision,
          damagedDetail: `${al.counts.damaged_units_30d} unit(s) written off, ${al.counts.damaged_returns_awaiting_decision} return(s) awaiting a decision`,
          expiryAlertDays: al.expiry_alert_days,
        }
      : null,
  };
}

export function createHttpApi(base: string): Api {
  return {
    ...createHttpV11(base, call),
    ...createHttpV2(base, call),
    ...createHttpV2(base, call),
    login: (req) =>
      call<MobileLoginResponse>(base, "POST", "/auth/mobile/login", { body: req }),
    refresh: (refreshToken) =>
      call<TokenPair>(base, "POST", "/auth/mobile/refresh", { body: { refreshToken } }),
    logout: (refreshToken) =>
      call<void>(base, "POST", "/auth/mobile/logout", { body: { refreshToken } }),
    registerDevice: (token, body) => call<void>(base, "POST", "/devices", { token, body }),
    homeAttention: (token) => call<HomeAttention>(base, "GET", "/home/attention", { token }),
    homeSummary: (token) => call<HomeSummary>(base, "GET", "/home/summary", { token }),
    appVersion: () => call<AppVersionInfo>(base, "GET", "/app/version"),

    approvals: (token, status) =>
      call<Paginated<Approval>>(base, "GET", `/approvals?status=${status}`, { token }),
    approve: (token, id) =>
      call<ApprovalDecisionResult>(base, "POST", `/approvals/${id}/approve`, { token, body: {} }),
    reject: (token, id, reason) =>
      call<ApprovalDecisionResult>(base, "POST", `/approvals/${id}/reject`, {
        token,
        body: { reason },
      }),

    notifications: (token, cursor) =>
      call<Paginated<AppNotification>>(
        base,
        "GET",
        `/notifications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        { token },
      ),

    stockLookup: (token, q) => {
      const qs = q.barcode
        ? `barcode=${encodeURIComponent(q.barcode)}`
        : `q=${encodeURIComponent(q.q ?? "")}`;
      return call<StockItem[]>(base, "GET", `/stock/lookup?${qs}`, { token });
    },
    stockAdjust: (token, req) =>
      call<AdjustResult>(base, "POST", "/stock/adjustments", { token, body: req }),

    orders: (token, f: OrderFilter) => {
      const p = new URLSearchParams();
      if (f.status) p.set("status", f.status);
      if (f.courier) p.set("courier", f.courier);
      if (f.unpaid) p.set("unpaid", "1");
      if (f.cursor) p.set("cursor", f.cursor);
      const qs = p.toString();
      return call<OrdersPage>(base, "GET", `/orders${qs ? `?${qs}` : ""}`, { token });
    },
    order: (token, id) => call<OrderDetail>(base, "GET", `/orders/${id}`, { token }),

    analytics: (token, range) => loadAnalytics(base, token, range),
  };
}
