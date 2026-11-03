import { ApiError } from "../errors";
import type {
  Api,
  AppVersionInfo,
  HomeAttention,
  HomeSummary,
  MobileLoginResponse,
  SessionUser,
  TokenPair,
} from "../types";

// Dev switches, flipped from the "Mock controls" card on the More screen.
export const mockControls = {
  offline: false,
  revokeDevice: false, // authenticated requests get DEVICE_REVOKED
  expireAccessToken: false, // next authenticated request gets TOKEN_EXPIRED once
  forceUpdate: false, // minimumVersion above the installed version
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
      permissions: ["approvals.decide", "stock.adjust", "cost.view", "orders.view"],
    },
  },
  manager: {
    password: "manager123",
    user: {
      id: 2,
      name: "Wanjiru",
      username: "manager",
      role: "manager",
      permissions: ["approvals.decide", "orders.view"],
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
        settings: { autoLockSeconds: 120 },
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
  };
}
