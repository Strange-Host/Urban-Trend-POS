import { ApiError } from "../errors";
import type {
  AdjustResult,
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
      permissions: ["approvals.decide", "stock.adjust", "stock.view", "cost.view", "orders.view"],
    },
  },
  manager: {
    password: "manager123",
    user: {
      id: 2,
      name: "Wanjiru",
      username: "manager",
      role: "manager",
      permissions: ["approvals.decide", "orders.view", "stock.view"],
    },
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

export function createMockApi(): Api {
  return {
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
  };
}
