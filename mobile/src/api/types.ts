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
  settings: {
    autoLockSeconds: number; // owner-configurable, default 120
    biometricApprovalAboveCents?: number; // approve above this needs biometric confirmation
  };
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

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

// ---- approvals (spec 5.1 #3, 5.2)
export type ApprovalType = "void" | "refund" | "requisition" | "expense" | "stock_adjustment";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalLine {
  name: string;
  qty: number;
  priceCents: number;
}

export interface Approval {
  id: number;
  type: ApprovalType;
  status: ApprovalStatus;
  requestedBy: string;
  requestedAt: string;
  amountCents: number;
  reason: string;
  items: ApprovalLine[];
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
}

/** applied=false means someone else decided first; `approval` carries the existing decision. */
export interface ApprovalDecisionResult {
  applied: boolean;
  approval: Approval;
}

// ---- alerts (same data as the web bell)
export interface AppNotification {
  id: number;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  deepLink: string;
}

// ---- stock (spec 5.1 #5-6)
export interface StockItem {
  id: number;
  sku: string;
  barcode: string | null;
  name: string;
  available: number;
  awaitingDispatch: number;
  dispatchedUnpaid: number;
  dispatchedPaid: number;
  returned: number;
}

export type AdjustReason =
  | "damaged"
  | "lost"
  | "found"
  | "count_correction"
  | "return_to_stock"
  | "other";

export interface AdjustRequest {
  productId: number;
  delta: number; // signed quantity change
  reason: AdjustReason;
  note?: string;
}

/** Above the server threshold the change is not applied; it becomes an approval for the owner. */
export interface AdjustResult {
  applied: boolean;
  approvalId?: number;
  newAvailable?: number;
}

// ---- orders (spec 5.1 #7)
export type OrderStatus =
  | "pending_confirmation"
  | "awaiting_dispatch"
  | "dispatched"
  | "delivered"
  | "returned"
  | "cancelled";
export type PaymentState = "paid" | "unpaid" | "partial";

export interface OrderSummary {
  id: number;
  number: string;
  customerName: string;
  status: OrderStatus;
  paymentState: PaymentState;
  courier: string | null;
  totalCents: number;
  createdAt: string;
}

export interface OrderDetail extends OrderSummary {
  customerPhone: string | null;
  courierPhone: string | null;
  deliveryFeeCents: number;
  items: ApprovalLine[];
  notes?: string;
}

export interface OrderFilter {
  status?: OrderStatus;
  courier?: string;
  unpaid?: boolean;
  cursor?: string;
}

export interface OrdersPage extends Paginated<OrderSummary> {
  couriers: string[]; // facet for the courier filter
}

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

  approvals(accessToken: string, status: ApprovalStatus): Promise<Paginated<Approval>>;
  approve(accessToken: string, id: number): Promise<ApprovalDecisionResult>;
  reject(accessToken: string, id: number, reason: string): Promise<ApprovalDecisionResult>;

  notifications(accessToken: string, cursor?: string): Promise<Paginated<AppNotification>>;

  stockLookup(accessToken: string, q: { barcode?: string; q?: string }): Promise<StockItem[]>;
  stockAdjust(accessToken: string, req: AdjustRequest): Promise<AdjustResult>;

  orders(accessToken: string, f: OrderFilter): Promise<OrdersPage>;
  order(accessToken: string, id: number): Promise<OrderDetail>;
}
