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
import { APPROVER_PERMS, STOCK_LOOKUP_PERMS } from "../../navigation/menu";

// Dev switches, flipped from the "Mock controls" card on the More screen.
export const mockControls = {
  offline: false,
  revokeDevice: false, // authenticated requests get DEVICE_REVOKED
  expireAccessToken: false, // next authenticated request gets TOKEN_EXPIRED once
  forceUpdate: false, // minimumVersion above the installed version
  alreadyDecided: false, // next approve/reject finds the item already decided by someone else
  latencyMs: 350,
};

// Permission names are the server's own (backend/src/config/permissions.js); the mock enforces them the way the server does.
const OWNER_PERMS = [
  "reports.view", "orders.view", "approvals.review", "expenses.approve", "requisitions.approve", "inventory.adjust",
  "inventory.approve_adjust", "orders.approve_duplicate", "orders.inspect", "products.manage", "products.view_cost", "prices.bulk",
  "stock.count", "stock.review", "stock.receive", "payments.reconcile", "couriers.settle", "leads.work", "returns.receive",
];

interface MockUser {
  password: string;
  user: SessionUser;
  /** Signs in with a code sent by text; the mock accepts OTP_CODE. */
  otp?: boolean;
}
export const OTP_CODE = "123456";

const USERS: Record<string, MockUser> = {
  owner: {
    password: "owner123",
    user: { id: 1, name: "Jon", email: "owner@urbantrends.test", role: "admin", store_id: 1, permissions: OWNER_PERMS },
  },
  manager: {
    password: "manager123",
    user: {
      id: 2,
      name: "Wanjiru",
      email: "manager@urbantrends.test",
      role: "manager",
      store_id: 1,
      // Catalog, stock-take, payments and couriers, but NOT products.view_cost, prices.bulk or inventory.approve_adjust: the manager
      // sees no cost, cannot change prices in bulk and cannot approve a large stock adjustment (the owner can grant them on the server).
      permissions: ["approvals.review", "expenses.approve", "requisitions.approve", "orders.view", "inventory.adjust", "reports.view", "products.manage", "stock.count", "stock.review", "stock.receive", "payments.reconcile", "couriers.settle", "leads.work", "returns.receive", "orders.inspect", "orders.approve_duplicate"],
    },
  },
  // Telesales agents: only their own assigned orders and leads, and they can receive a returned parcel. A second agent exists so
  // "someone else's order" can be tried (it is a 404, not an error screen).
  agent: {
    password: "agent123",
    user: { id: 4, name: "Njoki", email: "agent@urbantrends.test", role: "cashier", store_id: 1, permissions: ["telesales.work", "leads.work", "returns.receive", "stock.count"] },
  },
  agent2: {
    password: "agent123",
    user: { id: 5, name: "Otieno", email: "agent2@urbantrends.test", role: "cashier", store_id: 1, permissions: ["telesales.work", "leads.work", "returns.receive", "stock.count"] },
  },
  // Counts stock and nothing else: useful for trying the stock-take without catalog access.
  keeper: {
    password: "keeper123",
    user: { id: 3, name: "Brian", email: "keeper@urbantrends.test", role: "store", store_id: 1, permissions: ["stock.count", "stock.receive"] },
  },
  // An account that signs in with a text-message code (the code is 123456).
  otp: {
    password: "otp123",
    otp: true,
    user: { id: 6, name: "Amina", email: "otp@urbantrends.test", role: "manager", store_id: 1, permissions: ["approvals.review", "orders.view", "reports.view"] },
  },
};
const userKeyOf = (login: string): string | undefined => {
  const l = login.trim().toLowerCase();
  return Object.keys(USERS).find((k) => k === l || (USERS[k] as MockUser).user.email === l);
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
  return { accessToken, refreshToken };
}

const BIOMETRIC_ABOVE_CENTS = 500_000;
const session = (username: string): MobileLoginResponse => ({
  ...issue(username),
  user: (USERS[username] as MockUser).user,
  settings: { autoLockSeconds: 120, biometricApprovalAboveCents: BIOMETRIC_ABOVE_CENTS },
  sessionId: 7,
  sessionExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
});
const challenges = new Map<string, string>();


const mins = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const ap = (a: Partial<Approval> & Pick<Approval, "id" | "type" | "requestedBy" | "requestedAt" | "amountCents" | "reason">): Approval => ({
  status: "pending",
  title: "",
  items: [],
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  ...a,
});

const approvals: Approval[] = [
  ap({ id: "void:1", type: "void", title: "Void sale #1", requestedBy: "Brian (cashier)", requestedAt: mins(240), amountCents: 640_000, reason: "Customer changed mind after payment keyed in", items: [{ name: "Linen shirt L", qty: 2, priceCents: 320_000 }] }),
  ap({ id: "void:2", type: "void", title: "Void sale #2", requestedBy: "Faith (cashier)", requestedAt: mins(95), amountCents: 120_000, reason: "Wrong size scanned", items: [{ name: "Canvas belt", qty: 1, priceCents: 120_000 }] }),
  ap({ id: "refund:3", type: "refund", title: "Refund sale #3", requestedBy: "Wanjiru (manager)", requestedAt: mins(30), amountCents: 1_080_000, reason: "Item returned unworn within 7 days", items: [{ name: "Denim jacket M", qty: 1, priceCents: 780_000 }, { name: "Cap", qty: 1, priceCents: 300_000 }] }),
  ap({ id: "expense:4", type: "expense", title: "Shop cleaning supplies", status: "approved", requestedBy: "Wanjiru (manager)", requestedAt: mins(2000), amountCents: 350_000, reason: "Shop cleaning supplies", decidedBy: "Jon", decidedAt: mins(1900) }),
];
let nextApprovalId = 5;

const notifications: AppNotification[] = [
  { id: 1, type: "approval", severity: "warning", title: "Approval needed", body: "Refund KES 10,800 from Wanjiru", createdAt: mins(30), read: false, deepLink: "approval:3" },
  { id: 2, type: "courier_remittance_overdue", severity: "urgent", title: "Courier remittance overdue", body: "Swift Riders owes KES 41,000 (3 days)", createdAt: mins(180), read: false, deepLink: "courier:2" },
  { id: 3, type: "unmatched_payment", severity: "warning", title: "Unmatched payment", body: "M-Pesa KES 4,500 from 0712 345 678 waiting over 1 hour", createdAt: mins(240), read: true, deepLink: "payment_notification:9" },
  { id: 4, type: "order", severity: "info", title: "Order returned", body: "UT-1004 came back from the courier", createdAt: mins(1400), read: true, deepLink: "order:1004" },
  { id: 5, type: "security", severity: "info", title: "New device login", body: "A new phone signed in as manager", createdAt: mins(1500), read: true, deepLink: "" },
];

const stock: StockItem[] = [
  { id: 1, sku: "LIN-SH-L", barcode: "6161100010011", name: "Linen shirt L", available: 14, awaitingDispatch: 3, dispatchedUnpaid: 2, dispatchedPaid: 9, returned: 1 },
  { id: 2, sku: "DEN-JK-M", barcode: "6161100010028", name: "Denim jacket M", available: 4, awaitingDispatch: 1, dispatchedUnpaid: 3, dispatchedPaid: 6, returned: 0 },
  { id: 3, sku: "CAN-BLT", barcode: "6161100010035", name: "Canvas belt", available: 31, awaitingDispatch: 0, dispatchedUnpaid: 1, dispatchedPaid: 12, returned: 2 },
  { id: 4, sku: "CAP-BLK", barcode: "6161100010042", name: "Cap black", available: 2, awaitingDispatch: 4, dispatchedUnpaid: 0, dispatchedPaid: 20, returned: 0 },
];

const COURIERS = ["Swift Riders", "Mtaani Express", "Direct Boda"];
const STATUSES: OrderStatus[] = ["awaiting_dispatch", "dispatched_unpaid", "dispatched_partial", "dispatched_paid", "returned_awaiting_inspection", "returned_resellable", "returned_damaged", "cancelled"];
const NAMES = ["Achieng", "Kamau", "Njeri", "Otieno", "Mwende", "Barasa", "Chebet", "Kiptoo"];

const orders: OrderDetail[] = Array.from({ length: 34 }, (_, i) => {
  const status = STATUSES[i % STATUSES.length] as OrderStatus;
  const paymentState: PaymentState =
    status === "dispatched_paid" ? "paid" : status === "dispatched_partial" ? "partial" : "unpaid";
  const courier = status.startsWith("dispatched") || status.startsWith("returned") ? (COURIERS[i % COURIERS.length] as string) : null;
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
const requirePerm = (username: string, perm: string) => requireAny(username, [perm]);
const requireAny = (username: string, perms: string[]) => {
  const have = USERS[username]?.user.permissions ?? [];
  if (!perms.some((p) => have.includes(p))) throw new ApiError("FORBIDDEN", "You do not have permission to do that.", 403);
};

function decide(id: string, who: string, status: "approved" | "rejected", note?: string): ApprovalDecisionResult {
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
  a.decidedBy = USERS[who]?.user.name ?? null;
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
      const key = userKeyOf(req.email);
      const rec = key ? USERS[key] : undefined;
      if (!key || !rec || rec.password !== req.password)
        throw new ApiError("INVALID_CREDENTIALS", "Invalid email or password.", 401);
      mockControls.revokeDevice = false;
      if (rec.otp) {
        const challengeToken = mint("ch");
        challenges.set(challengeToken, key);
        return { twoFactorRequired: true as const, challengeToken, phoneHint: "07•• ••• 678", expiresInSeconds: 300 };
      }
      return session(key);
    },

    async verifyOtp(req) {
      await gate();
      const key = challenges.get(req.challengeToken);
      if (!key) throw new ApiError("INVALID_CREDENTIALS", "That sign-in has expired. Start again.", 401);
      if (req.code.trim() !== OTP_CODE) throw new ApiError("INVALID_CREDENTIALS", "That code is not right.", 401);
      challenges.delete(req.challengeToken);
      return session(key);
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
      return session(u);
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
      const isAdmin = u === "owner";
      const items: HomeAttention["items"] = [
        { id: "approval_request:3", kind: "approval_request", severity: "urgent", title: "Refund of KES 10,800 waiting", detail: "Requested by Wanjiru (manager)", amountCents: 1_080_000, since: mins(240), link: { type: "approval", id: 3 } },
        { id: "courier_remittance_overdue:2", kind: "courier_remittance_overdue", severity: "warning", title: "Swift Riders owes KES 41,000", detail: "3 days overdue", amountCents: 4_100_000, since: mins(4320), link: { type: "courier", id: 2 } },
      ];
      if (isAdmin)
        items.push({ id: "unmatched_payment:9", kind: "unmatched_payment", severity: "warning", title: "Unmatched M-Pesa payment", detail: "KES 4,500 from 0712 345 678", amountCents: 450_000, since: mins(95), link: { type: "unmatched_payment", id: 9 } });
      items.push({ id: "stock_transfer_pending:5", kind: "stock_transfer_pending", severity: "info", title: "Stock transfer waiting", detail: "Opens on the website", amountCents: null, since: null, link: { type: "stock_transfer", id: 5 } });
      const counts: Record<string, number> = {};
      for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
      return { total: items.length, counts, items, generatedAt: ago(2) };
    },

    async homeSummary(token): Promise<HomeSummary> {
      await gate();
      const u = authed(token);
      const base = { generatedAt: ago(2), date: isoDay(new Date()), currency: "KES" };
      if (!USERS[u]?.user.permissions.includes("reports.view")) return { ...base, scope: "mine", mySalesCount: 4, mySalesCents: 1_240_000 };
      return {
        ...base,
        scope: "shop",
        posSalesCents: 9_230_000,
        posSalesCount: 29,
        onlineSalesCents: 5_000_000,
        onlineOrderCount: 9,
        totalSalesCents: 14_230_000,
        cashCollectedCents: 7_100_000,
        lowStockCount: 6,
        attentionCount: 4,
      };
    },

    async appVersion(current): Promise<AppVersionInfo> {
      await gate();
      const minimumVersion = mockControls.forceUpdate ? "9.0.0" : "0.1.0";
      const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
      return {
        minimumVersion,
        latestVersion: "0.1.0",
        downloadUrl: "https://example.invalid/urbantrends.apk",
        updateRequired: current ? cmp(current, minimumVersion) < 0 : false,
        updateAvailable: current ? cmp(current, "0.1.0") < 0 : false,
      };
    },
    async approvals(token, status) {
      await gate();
      const u = authed(token);
      requireAny(u, APPROVER_PERMS);
      const items = approvals
        .filter((a) => a.status === status)
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
        .map((a) => ({ ...a }));
      return { items, nextCursor: null };
    },

    async approve(token, id, biometricConfirmed) {
      await gate();
      const u = authed(token);
      requireAny(u, APPROVER_PERMS);
      // the server's rule: at or above the owner's limit, the phone must have confirmed with fingerprint or face
      const a = approvals.find((x) => x.id === id);
      if (a && a.status === "pending" && (a.amountCents ?? 0) >= BIOMETRIC_ABOVE_CENTS && biometricConfirmed !== true)
        throw new ApiError("BIOMETRIC_REQUIRED", "Confirm with your fingerprint or face to approve this amount.", 403);
      return decide(id, u, "approved");
    },

    async reject(token, id, reason) {
      await gate();
      const u = authed(token);
      requireAny(u, APPROVER_PERMS);
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
      const u = authed(token);
      requireAny(u, STOCK_LOOKUP_PERMS);
      const term = (q.q ?? "").trim().toLowerCase();
      const hits = q.barcode
        ? stock.filter((p) => p.barcode === q.barcode)
        : stock.filter((p) => p.name.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term));
      return hits.map((p) => ({ ...p }));
    },

    async stockAdjust(token, req): Promise<AdjustResult> {
      await gate();
      const u = authed(token);
      requirePerm(u, "inventory.adjust");
      const p = stock.find((x) => x.id === req.productId);
      if (!p) throw new ApiError("UNKNOWN", "Product not found", 404);
      if (!req.delta) throw new ApiError("UNKNOWN", "Quantity change cannot be zero", 400);
      if (p.available + req.delta < 0) throw new ApiError("UNKNOWN", "Available stock cannot go below zero", 400);
      if (Math.abs(req.delta) > 20) {
        const id = `stock_adjustment:${nextApprovalId++}`;
        approvals.push(
          ap({
            id,
            type: "stock_adjustment",
            title: `Stock adjustment for ${p.name}`,
            requestedBy: USERS[u]?.user.name ?? u,
            requestedAt: new Date().toISOString(),
            amountCents: null,
            reason: `${req.reason}${req.note ? `: ${req.note}` : ""}`,
            items: [{ name: `${p.name} (${req.delta > 0 ? "+" : ""}${req.delta})`, qty: Math.abs(req.delta), priceCents: null }],
          }),
        );
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
          (!f.unpaid || o.status === "dispatched_unpaid" || o.status === "dispatched_partial"),
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
