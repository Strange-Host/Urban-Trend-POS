// Contract for /api/v1 as described in the v1 spec (sections 3, 4, 5.3).
// ASSUMPTION: field names below are inferred from the spec, not read from the
// backend. Before pointing the app at the real server, reconcile this file first.
// Money is integer cents (same convention as the rest of the POS API).

export type Role = "owner" | "manager" | "dispatch" | "telesales";

export interface SessionUser {
  id: number;
  name: string;
  username: string;
  role: Role;
  permissions: string[];
}

export interface DeviceInfo {
  name: string;
  appVersion: string;
}

export interface MobileLoginRequest {
  username: string;
  password: string;
  device: DeviceInfo;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string; // returned in body in mobile mode, stored in Keystore
  expiresIn: number; // seconds
}

export interface MobileLoginResponse extends TokenPair {
  user: SessionUser;
  deviceId: number;
  settings: { autoLockSeconds: number }; // owner-configurable, default 120
}

export type AttentionKind =
  | "approvals"
  | "money_at_risk"
  | "unmatched_payments"
  | "stock_alerts";

export interface AttentionItem {
  id: string;
  kind: AttentionKind; // server returns these already ordered by urgency
  title: string;
  subtitle: string;
  badge?: string; // e.g. "Oldest 4h"
  urgent?: boolean;
  deepLink: string; // e.g. "approvals" | "orders?unpaid=1" | "stock?alerts=1"
}

export interface HomeAttention {
  total: number;
  items: AttentionItem[];
  generatedAt: string; // ISO; server caches 30-60 s
}

export interface HomeSummary {
  salesCents: number;
  orders: number;
  cashVarianceCents: number;
  generatedAt: string;
}

export interface AppVersionInfo {
  minimumVersion: string;
  latestVersion: string;
  downloadUrl: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export type ApiErrorCode =
  | "INVALID_CREDENTIALS"
  | "TOKEN_EXPIRED"
  | "REFRESH_INVALID" // rotation / replay detected / token_version bumped
  | "DEVICE_REVOKED"
  | "FORBIDDEN"
  | "NETWORK" // client-side: no connection
  | "UNKNOWN";

// The surface the app depends on. Mock and HTTP both implement this.
export interface Api {
  login(req: MobileLoginRequest): Promise<MobileLoginResponse>;
  refresh(refreshToken: string): Promise<TokenPair>;
  logout(refreshToken: string): Promise<void>;
  registerDevice(
    accessToken: string,
    body: DeviceInfo & { pushToken?: string },
  ): Promise<void>;
  homeAttention(accessToken: string): Promise<HomeAttention>;
  homeSummary(accessToken: string): Promise<HomeSummary>;
  appVersion(): Promise<AppVersionInfo>;
}
