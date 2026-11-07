import { addDays, isoDay } from "../../lib/analytics";
import { ApiError } from "../errors";
import { createMockV11 } from "./mockApiV11";
import { createMockV2 } from "./mockApiV2";
import type {
  AdjustResult,
  Analytics,
  AnalyticsRange,
  Api,
  AppNotification,
  AppVersionInfo,
  Approval,
  ApprovalDecisionResult,
  HomeAttention,
  HomeSummary,
  MobileLoginResponse,
  OrderDetail,
  OrderStatus,
  OrderSummary,
  PaymentState,
  SessionUser,
  StockItem,
  TokenPair,
} from "../types";

// Dev switches, flipped from the "Mock controls" card on the More screen.
export const mockControls = {
  offline: false,
  revokeDevice: false, // authenticated requests get DEVICE_REVOKED
  expireAccessToken: false, // next authenticated request gets TOKEN_EXPIRED once
  forceUpdate: false, // minimumVersion above the installed version
  alreadyDecided: false, // next approve/reject finds the item already decided by someone else
  latencyMs: 350,
};

const USERS: Record<string, { password: string; user: SessionUser }> = {
  owner: {
    password: "owner123",
    user: {
      id: 1,
      name: "Jon",
      username: "owner",
      role: "owner",
      permissions: ["approvals.decide", "stock.adjust", "stock.view", "cost.view", "orders.view", "reports.view"],
    },
  },
  manager: {
    password: "manager123",
    user: {
      id: 2,
      name: "Wanjiru",
      username: "manager",
      role: "manager",
      // Catalog, stock-take, payments and couriers, but NOT products.view_cost or prices.bulk: the manager sees no cost and
      // cannot change prices in bulk (the owner can grant both on the server).
      permissions: ["approvals.decide", "orders.view", "stock.view", "reports.view", "products.manage", "stock.count", "stock.review", "payments.reconcile", "couriers.settle", "leads.work", "returns.receive", "orders.inspect", "orders.approve_duplicate"],
    },
  },
  // Telesales agents: only their own assigned orders and leads, and they can receive a returned parcel. A second agent exists so
  // "someone else's order" can be tried (it is a 404, not an error screen).
  agent: {
    password: "agent123",
    user: { id: 4, name: "Njoki", username: "agent", role: "telesales", permissions: ["telesales.work", "leads.work", "returns.receive"] },
  },
  agent2: {
    password: "agent123",
    user: { id: 5, name: "Otieno", username: "agent2", role: "telesales", permissions: ["telesales.work", "leads.work", "returns.receive"] },
  },
  // Counts stock and nothing else: useful for trying the stock-take without catalog access.
  keeper: {
    password: "keeper123",
    user: { id: 3, name: "Brian", username: "keeper", role: "dispatch", permissions: ["stock.count", "stock.view"] },
  },
};

// Refresh tokens rotate: reusing an old one is replay and kills the family.
const access = new Map<string, string>();
const refreshLive = new Map<string, string>();
const refreshUsed = new Set<string>();
let counter = 0;
const mint = (p: string) => `${p}_${++counter}_${Math.random().toString(36).slice(2, 10)}`;

const sleep = () => new Promise((r) => setTimeout(r, mockControls.latencyMs));

async function gate() {
  await sleep();
  if (mockControls.offline) throw new ApiError("NETWORK", "No connection");
}

function authed(token: string): string {
  if (mockControls.revokeDevice)
    throw new ApiError("DEVICE_REVOKED", "This device was signed out by the owner", 401);
  if (mockControls.expireAccessToken) {
    mockControls.expireAccessToken = false;
    access.delete(token);
  }
  const u = access.get(token);
  if (!u) throw new ApiError("TOKEN_EXPIRED", "Access token expired", 401);
  return u;
}

function issue(username: string): TokenPair {
  const accessToken = mint("at");
  const refreshToken = mint("rt");
  access.set(accessToken, username);
  refreshLive.set(refreshToken, username);
  return { accessToken, refreshToken, expiresIn: 900 };
}


const mins = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const approvals: Approval[] = [
  {
    id: 1,
    type: "void",
    status: "pending",
    requestedBy: "Brian (cashier)",
    requestedAt: mins(240),
    amountCents: 640_000,
    reason: "Customer changed mind after payment keyed in",
    items: [{ name: "Linen shirt L", qty: 2, priceCents: 320_000 }],
  },
  {
    id: 2,
    type: "void",
    status: "pending",
    requestedBy: "Faith (cashier)",
    requestedAt: mins(95),
    amountCents: 120_000,
    reason: "Wrong size scanned",
    items: [{ name: "Canvas belt", qty: 1, priceCents: 120_000 }],
  },
  {
    id: 3,
    type: "refund",
    status: "pending",
    requestedBy: "Wanjiru (manager)",
    requestedAt: mins(30),
    amountCents: 1_080_000,
    reason: "Item returned unworn within 7 days",
    items: [
      { name: "Denim jacket M", qty: 1, priceCents: 780_000 },
      { name: "Cap", qty: 1, priceCents: 300_000 },
    ],
  },
  {
    id: 4,
    type: "expense",
    status: "approved",
    requestedBy: "Wanjiru (manager)",
    requestedAt: mins(2000),
    amountCents: 350_000,
    reason: "Shop cleaning supplies",
    items: [],
    decidedBy: "Jon",
    decidedAt: mins(1900),
  },
];
let nextApprovalId = 5;

const notifications: AppNotification[] = [
  { id: 1, title: "Approval needed", body: "Refund KES 10,800 from Wanjiru", createdAt: mins(30), read: false, deepLink: "approvals/3" },
  { id: 2, title: "Courier remittance overdue", body: "Swift Riders owes KES 41,000 (3 days)", createdAt: mins(180), read: false, deepLink: "orders?unpaid=1" },
  { id: 3, title: "Unmatched payment", body: "M-Pesa KES 4,500 from 0712 345 678 waiting over 1 hour", createdAt: mins(240), read: true, deepLink: "payments/unmatched" },
  { id: 4, title: "New device login", body: "A new phone signed in as manager", createdAt: mins(1400), read: true, deepLink: "more" },
];

const stock: StockItem[] = [
  { id: 1, sku: "LIN-SH-L", barcode: "6161100010011", name: "Linen shirt L", available: 14, awaitingDispatch: 3, dispatchedUnpaid: 2, dispatchedPaid: 9, returned: 1 },
  { id: 2, sku: "DEN-JK-M", barcode: "6161100010028", name: "Denim jacket M", available: 4, awaitingDispatch: 1, dispatchedUnpaid: 3, dispatchedPaid: 6, returned: 0 },
  { id: 3, sku: "CAN-BLT", barcode: "6161100010035", name: "Canvas belt", available: 31, awaitingDispatch: 0, dispatchedUnpaid: 1, dispatchedPaid: 12, returned: 2 },
  { id: 4, sku: "CAP-BLK", barcode: "6161100010042", name: "Cap black", available: 2, awaitingDispatch: 4, dispatchedUnpaid: 0, dispatchedPaid: 20, returned: 0 },
];

const COURIERS = ["Swift Riders", "Mtaani Express", "Direct Boda"];
const STATUSES: OrderStatus[] = ["pending_confirmation", "awaiting_dispatch", "dispatched", "delivered", "returned", "cancelled"];
const NAMES = ["Achieng", "Kamau", "Njeri", "Otieno", "Mwende", "Barasa", "Chebet", "Kiptoo"];

const orders: OrderDetail[] = Array.from({ length: 34 }, (_, i) => {
  const status = STATUSES[i % STATUSES.length] as OrderStatus;
  const dispatched = status === "dispatched" || status === "delivered";
  const paymentState: PaymentState =
    status === "delivered" ? "paid" : status === "dispatched" ? (i % 2 ? "unpaid" : "paid") : status === "cancelled" ? "unpaid" : "unpaid";
  const courier = dispatched || status === "returned" ? (COURIERS[i % COURIERS.length] as string) : null;
  return {
    id: 1000 + i,
    number: `UT-${1000 + i}`,
    customerName: `${NAMES[i % NAMES.length]} ${i + 1}`,
    status,
    paymentState,
    courier,
    totalCents: (1500 + i * 130) * 100,
    createdAt: mins(60 * (i + 1)),
    customerPhone: `0712${String(100000 + i * 37).slice(0, 6)}`,
    courierPhone: courier ? `07${20 + (i % 3)}${String(500000 + i * 11).slice(0, 6)}` : null,
    deliveryFeeCents: 30_000,
    items: [{ name: (stock[i % stock.length] as StockItem).name, qty: 1 + (i % 3), priceCents: 150_000 }],
  };
});

const PAGE = 10;
const requirePerm = (username: string, perm: string) => {
  if (!USERS[username]?.user.permissions.includes(perm))
    throw new ApiError("FORBIDDEN", "You do not have permission for this", 403);
};

function decide(id: number, who: string, status: "approved" | "rejected", note?: string): ApprovalDecisionResult {
  const a = approvals.find((x) => x.id === id);
  if (!a) throw new ApiError("UNKNOWN", "Approval not found", 404);
  if (mockControls.alreadyDecided && a.status === "pending") {
    mockControls.alreadyDecided = false;
    a.status = "rejected";
    a.decidedBy = "Wanjiru";
    a.decidedAt = mins(1);
    a.decisionNote = "Duplicate request";
  }
  if (a.status !== "pending") return { applied: false, approval: { ...a } };
  a.status = status;
  a.decidedBy = USERS[who]?.user.name;
  a.decidedAt = new Date().toISOString();
  if (note) a.decisionNote = note;
  return { applied: true, approval: { ...a } };
}

const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

// ---- analytics: deterministic sample data so the charts look the same on every launch
function seeded(seed: number) {
  let x = seed % 2147483647;
  if (x <= 0) x += 2147483646;
  return () => (x = (x * 16807) % 2147483647) / 2147483647;
}

function buildAnalytics(range: AnalyticsRange): Analytics {
  const now = new Date();
  const days = range === "all" ? 365 : Number(range);
  const weekday = [0.8, 0.9, 0.95, 1, 1.15, 1.4, 1.2]; // Sun..Sat shape
  const rnd = seeded(7);
  const makeDays = (n: number, offset: number) => {
    const out: { day: string; bySource: Record<string, number> }[] = [];
    for (let i = n; i >= 0; i--) {
      const d = addDays(now, -(i + offset));
      const f = weekday[d.getDay()] as number;
      const growth = 0.75 + 0.25 * (1 - (i + offset) / 400);
      const local = Math.round((38_000 + rnd() * 26_000) * f * growth) * 100;
      const shopify = Math.round((16_000 + rnd() * 22_000) * f * growth) * 100;
      const woo = rnd() > 0.35 ? Math.round((5_000 + rnd() * 9_000) * f * growth) * 100 : 0;
      out.push({ day: isoDay(d), bySource: woo ? { local, shopify, woocommerce: woo } : { local, shopify } });
    }
    return out;
  };
  const trend = makeDays(days, 0);
  const sum = (rows: typeof trend) => rows.reduce((s, r) => s + Object.values(r.bySource).reduce((a, b) => a + b, 0), 0);
  const by = (src: string) => trend.reduce((s, r) => s + (r.bySource[src] ?? 0), 0);
  const revenue = sum(trend);
  const txns = Math.round(revenue / 100 / 2_150);
  const prevRevenue = range === "all" ? null : sum(makeDays(days, days + 1));

  const channels = (
    [
      ["local", "Main shop", null, 0.34],
      ["shopify", "Urban Trends Shopify", "shopify", 0.17],
      ["woocommerce", "Urban Trends WordPress", "woocommerce", 0.12],
    ] as const
  ).map(([sourceType, channelName, platform, price]) => {
    const rev = by(sourceType);
    const t = Math.max(1, Math.round((rev / 100) * price * 0.0035));
    return { sourceType, channelName, platform, transactions: t, revenueCents: rev, avgBasketCents: Math.round(rev / t) };
  });

  const prod = (id: number, name: string, units: number, unit: number) => ({
    id,
    name,
    unitsSold: units,
    revenueCents: units * unit * 100,
  });
  const k = days / 30;
  const methodsTotal = revenue;
  return {
    range,
    generatedAt: new Date().toISOString(),
    summary: { revenueCents: revenue, transactions: txns, avgBasketCents: Math.round(revenue / Math.max(1, txns)) },
    previous:
      prevRevenue === null
        ? null
        : { revenueCents: prevRevenue, transactions: Math.round(prevRevenue / 100 / 2_150), avgBasketCents: 215_000 },
    inventoryRetailValueCents: 48_650_000,
    channels,
    trend,
    paymentMethods: [
      { method: "mpesa", totalCents: Math.round(methodsTotal * 0.58), count: Math.round(txns * 0.6) },
      { method: "cash", totalCents: Math.round(methodsTotal * 0.27), count: Math.round(txns * 0.25) },
      { method: "card", totalCents: Math.round(methodsTotal * 0.1), count: Math.round(txns * 0.1) },
      { method: "bank_transfer", totalCents: Math.round(methodsTotal * 0.05), count: Math.round(txns * 0.05) },
    ],
    topByChannel: {
      local: [
        prod(1, "Crew Sock 3-pack", Math.round(64 * k), 650),
        prod(2, "Oversized Tee, Black", Math.round(41 * k), 1800),
        prod(3, "Canvas Cap", Math.round(37 * k), 950),
        prod(4, "Zip Hoodie", Math.round(22 * k), 3400),
      ],
      shopify: [
        prod(2, "Oversized Tee, Black", Math.round(52 * k), 1800),
        prod(5, "Cargo Joggers", Math.round(30 * k), 2900),
        prod(4, "Zip Hoodie", Math.round(18 * k), 3400),
      ],
      woocommerce: [prod(3, "Canvas Cap", Math.round(14 * k), 950), prod(1, "Crew Sock 3-pack", Math.round(11 * k), 650)],
    },
    overview: {
      date: isoDay(now),
      posRevenueCents: 3_840_000,
      onlineRevenueCents: 2_150_000,
      combinedRevenueCents: 5_990_000,
      posTransactions: 17,
      onlineOrders: 9,
      cashCollectedCents: 4_720_000,
      lowStockCount: 6,
      unpaidParcels: [
        { courier: "boda", count: 5, owedCents: 1_240_000 },
        { courier: "g4s", count: 3, owedCents: 860_000 },
      ],
      orderStatus: [
        { status: "pending_confirmation", count: 7, outstandingCents: 1_450_000 },
        { status: "awaiting_dispatch", count: 11, outstandingCents: 2_310_000 },
        { status: "dispatched_unpaid", count: 8, outstandingCents: 2_100_000 },
        { status: "dispatched_paid", count: 34, outstandingCents: 0 },
        { status: "returned", count: 2, outstandingCents: 0 },
      ],
      stockCostValueCents: 21_300_000,
      stockUnits: 1_284,
    },
    stockAlerts: {
      expiring: 2,
      expired: 0,
      recalled: 0,
      damaged: 3,
      damagedDetail: "2 unit(s) written off, 1 return(s) awaiting a decision",
      expiryAlertDays: 30,
    },
  };
}

export function createMockApi(): Api {
  const v11 = createMockV11({
    gate,
    userFor: (token) => (USERS[authed(token)] as { user: SessionUser }).user,
  });
  const v2 = createMockV2({
    gate,
    userFor: (token) => (USERS[authed(token)] as { user: SessionUser }).user,
  });
  return {
    ...v11,
    ...v2,
    async login(req) {
      await gate();
      const rec = USERS[req.username.trim().toLowerCase()];
      if (!rec || rec.password !== req.password)
        throw new ApiError("INVALID_CREDENTIALS", "Wrong username or password", 401);
      mockControls.revokeDevice = false;
      const res: MobileLoginResponse = {
        ...issue(rec.user.username),
        user: rec.user,
        deviceId: 7,
        settings: { autoLockSeconds: 120, biometricApprovalAboveCents: 500_000 },
      };
      return res;
    },

    async refresh(refreshToken) {
      await gate();
      if (refreshUsed.has(refreshToken)) {
        refreshLive.clear();
        throw new ApiError("REFRESH_INVALID", "Session no longer valid", 401);
      }
      const u = refreshLive.get(refreshToken);
      if (!u) throw new ApiError("REFRESH_INVALID", "Session no longer valid", 401);
      if (mockControls.revokeDevice)
        throw new ApiError("DEVICE_REVOKED", "This device was signed out by the owner", 401);
      refreshLive.delete(refreshToken);
      refreshUsed.add(refreshToken);
      return issue(u);
    },

    async logout(refreshToken) {
      await gate();
      refreshLive.delete(refreshToken);
    },

    async registerDevice(token) {
      await gate();
      authed(token);
    },

    async homeAttention(token): Promise<HomeAttention> {
      await gate();
      const u = authed(token);
      const isOwner = u === "owner";
      const items: HomeAttention["items"] = [
        {
          id: "appr",
          kind: "approvals",
          title: "3 approvals waiting",
          subtitle: "2 voids, 1 refund · KES 18,400",
          badge: "Oldest 4h",
          urgent: true,
          deepLink: "approvals",
        },
        {
          id: "risk",
          kind: "money_at_risk",
          title: "Money at risk · KES 96,200",
          subtitle: "11 unpaid parcels · 2 courier remittances overdue",
          deepLink: "orders?unpaid=1",
        },
      ];
      if (isOwner)
        items.push({
          id: "unm",
          kind: "unmatched_payments",
          title: "4 unmatched M-Pesa payments",
          subtitle: "KES 23,500 waiting to be matched",
          deepLink: "payments/unmatched",
        });
      items.push({
        id: "stk",
        kind: "stock_alerts",
        title: "9 items low on stock",
        subtitle: "3 stuck in Awaiting Dispatch over 48h",
        deepLink: "stock?alerts=1",
      });
      return { total: items.length + 3, items, generatedAt: ago(2) };
    },

    async homeSummary(token): Promise<HomeSummary> {
      await gate();
      authed(token);
      return {
        salesCents: 14_230_000,
        orders: 38,
        cashVarianceCents: -20_000,
        generatedAt: ago(2),
      };
    },

    async appVersion(): Promise<AppVersionInfo> {
      await gate();
      return {
        minimumVersion: mockControls.forceUpdate ? "9.0.0" : "0.1.0",
        latestVersion: "0.1.0",
        downloadUrl: "https://example.invalid/urbantrends.apk",
      };
    },
    async approvals(token, status) {
      await gate();
      const u = authed(token);
      requirePerm(u, "approvals.decide");
      const items = approvals
        .filter((a) => a.status === status)
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
        .map((a) => ({ ...a }));
      return { items, nextCursor: null };
    },

    async approve(token, id) {
      await gate();
      const u = authed(token);
      requirePerm(u, "approvals.decide");
      return decide(id, u, "approved");
    },

    async reject(token, id, reason) {
      await gate();
      const u = authed(token);
      requirePerm(u, "approvals.decide");
      if (!reason.trim()) throw new ApiError("UNKNOWN", "A reason is required", 400);
      return decide(id, u, "rejected", reason.trim());
    },

    async notifications(token) {
      await gate();
      authed(token);
      return { items: notifications.map((n) => ({ ...n })), nextCursor: null };
    },

    async stockLookup(token, q) {
      await gate();
      authed(token);
      const term = (q.q ?? "").trim().toLowerCase();
      const hits = q.barcode
        ? stock.filter((p) => p.barcode === q.barcode)
        : stock.filter((p) => p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term));
      return hits.map((p) => ({ ...p }));
    },

    async stockAdjust(token, req): Promise<AdjustResult> {
      await gate();
      const u = authed(token);
      requirePerm(u, "stock.adjust");
      const p = stock.find((x) => x.id === req.productId);
      if (!p) throw new ApiError("UNKNOWN", "Product not found", 404);
      if (!req.delta) throw new ApiError("UNKNOWN", "Quantity change cannot be zero", 400);
      if (p.available + req.delta < 0) throw new ApiError("UNKNOWN", "Available stock cannot go below zero", 400);
      if (Math.abs(req.delta) > 20) {
        const id = nextApprovalId++;
        approvals.push({
          id,
          type: "stock_adjustment",
          status: "pending",
          requestedBy: USERS[u]?.user.name ?? u,
          requestedAt: new Date().toISOString(),
          amountCents: 0,
          reason: `${req.reason}${req.note ? `: ${req.note}` : ""}`,
          items: [{ name: `${p.name} (${req.delta > 0 ? "+" : ""}${req.delta})`, qty: Math.abs(req.delta), priceCents: 0 }],
        });
        return { applied: false, approvalId: id };
      }
      p.available += req.delta;
      return { applied: true, newAvailable: p.available };
    },

    async orders(token, f) {
      await gate();
      const u = authed(token);
      requirePerm(u, "orders.view");
      let list = orders.filter(
        (o) =>
          (!f.status || o.status === f.status) &&
          (!f.courier || o.courier === f.courier) &&
          (!f.unpaid || (o.paymentState !== "paid" && (o.status === "dispatched" || o.status === "returned"))),
      );
      const start = f.cursor ? parseInt(f.cursor, 10) || 0 : 0;
      const page = list.slice(start, start + PAGE);
      const next = start + PAGE < list.length ? String(start + PAGE) : null;
      const items: OrderSummary[] = page.map((o) => ({
        id: o.id,
        number: o.number,
        customerName: o.customerName,
        status: o.status,
        paymentState: o.paymentState,
        courier: o.courier,
        totalCents: o.totalCents,
        createdAt: o.createdAt,
      }));
      return { items, nextCursor: next, couriers: COURIERS };
    },

    async order(token, id) {
      await gate();
      const u = authed(token);
      requirePerm(u, "orders.view");
      const o = orders.find((x) => x.id === id);
      if (!o) throw new ApiError("UNKNOWN", "Order not found", 404);
      return { ...o };
    },

    async analytics(token, range) {
      await gate();
      const u = authed(token);
      requirePerm(u, "reports.view");
      return buildAnalytics(range);
    },
  };
}
