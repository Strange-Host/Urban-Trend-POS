// Contract for /api/v1, read from the server's own response schemas (backend/src/validation/mobile.responses.js and
// mobile.schema.js). The server is the source of truth: the live check (npm run live-check) drives this client against a
// running backend, so a drift shows up as a failing step rather than a broken screen.
// Money is integer cents (same convention as the rest of the POS API).
import type { ApiErrorCodeV11, ApiV11 } from "./typesV11";
import type { ApiErrorCodeV2, ApiV2 } from "./typesV2";

// What the server calls a role. Permissions, not the role, decide what a person sees; the role is for display and for
// the few owner-only actions the server itself restricts to admin.
export type Role = "admin" | "manager" | "cashier" | "store";

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  role: Role;
  store_id?: number | null;
  permissions: string[];
}

export interface DeviceInfo {
  name: string;
  appVersion: string;
  platform?: string;
  /** This install's own id, kept on the phone, so signing in again from the same phone reuses its device row. */
  deviceId?: string;
}

export interface MobileLoginRequest {
  email: string;
  password: string;
  device: DeviceInfo;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string; // single use: every refresh returns a new one. Kept in secure storage
}

export interface AppSettings {
  autoLockSeconds: number; // owner-configurable
  /** An approval of at least this amount needs fingerprint or face. null = never ask. */
  biometricApprovalAboveCents: number | null;
}

export interface MobileLoginResponse extends TokenPair {
  user: SessionUser;
  settings: AppSettings;
  sessionId: number;
  /** The hard end of this sign-in, however active the phone is. */
  sessionExpiresAt: string;
}

/** The account uses sign-in codes: the code went to `phoneHint`; answer it with verifyOtp. */
export interface OtpChallenge {
  twoFactorRequired: true;
  challengeToken: string;
  phoneHint: string;
  expiresInSeconds: number;
}

export type LoginResult = MobileLoginResponse | OtpChallenge;
export const isOtpChallenge = (r: LoginResult): r is OtpChallenge => "twoFactorRequired" in r;

export interface VerifyOtpRequest {
  challengeToken: string;
  code: string;
  device: DeviceInfo;
}

export type Severity = "info" | "warning" | "urgent";

/** Where tapping an attention item goes: the kind of record and its row id. */
export interface AttentionLink {
  type: string;
  id: number;
}

export interface AttentionItem {
  id: string; // stable per item, e.g. "approval_request:12"
  kind: string; // approval_request, unpaid_parcel, unmatched_payment, low_stock, ... (the server adds kinds over time)
  severity: Severity;
  title: string;
  detail: string | null;
  amountCents: number | null;
  since: string | null; // when it started waiting
  link: AttentionLink | null;
}

export interface HomeAttention {
  total: number; // everything waiting on this person, including items beyond those sent
  counts: Record<string, number>;
  items: AttentionItem[];
  generatedAt: string;
}

interface SummaryBase {
  generatedAt: string;
  date: string;
  currency: string;
}
/** People who may see reports get the whole shop. */
export interface HomeSummaryShop extends SummaryBase {
  scope: "shop";
  posSalesCents: number;
  posSalesCount: number;
  onlineSalesCents: number;
  onlineOrderCount: number;
  totalSalesCents: number;
  cashCollectedCents: number;
  lowStockCount: number;
  attentionCount: number;
}
/** Everyone else sees only their own sales today. Never cost or profit. */
export interface HomeSummaryMine extends SummaryBase {
  scope: "mine";
  mySalesCount: number;
  mySalesCents: number;
}
export type HomeSummary = HomeSummaryShop | HomeSummaryMine;

export interface AppVersionInfo {
  minimumVersion: string;
  latestVersion: string;
  /** null until the owner uploads an APK or sets a link. */
  downloadUrl: string | null;
  updateRequired: boolean;
  updateAvailable: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
  details?: unknown;
}

export type ApiErrorCode =
  | "INVALID_CREDENTIALS"
  | "TOKEN_EXPIRED" // the access token ran out: refresh once and retry
  | "REFRESH_INVALID" // the refresh token was refused (used twice, session ended, account changed): sign in again
  | "DEVICE_REVOKED" // the session was ended from elsewhere (owner revoked the phone, signed out on another device)
  | "FORBIDDEN"
  | "ACCOUNT_LOCKED" // too many wrong passwords; details.retryAfterMinutes
  | "PASSWORD_CHANGE_REQUIRED" // a temporary password: it must be changed on the website first
  | "BIOMETRIC_REQUIRED" // an approval above the owner's limit needs fingerprint or face
  | "RATE_LIMITED"
  | "NETWORK" // client-side: no connection
  | "UNKNOWN"
  | ApiErrorCodeV11
  | ApiErrorCodeV2;

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

// ---- approvals
export type ApprovalType = "void" | "refund" | "requisition" | "expense" | "stock_adjustment" | "duplicate_order";
export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalLine {
  name: string;
  qty: number;
  priceCents: number | null;
}

export interface Approval {
  id: string; // "<type>:<number>", e.g. "void:12"
  type: ApprovalType;
  status: ApprovalStatus;
  title: string;
  requestedBy: string;
  requestedAt: string;
  amountCents: number | null;
  reason: string;
  items: ApprovalLine[];
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

/** applied=false means someone else decided first; `approval` carries the existing decision. */
export interface ApprovalDecisionResult {
  applied: boolean;
  approval: Approval;
}

// ---- alerts (same data as the web bell)
export interface AppNotification {
  id: number;
  type: string;
  severity: Severity;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
  /** "<entity>:<id>" (e.g. "order:41") or empty. */
  deepLink: string;
}

// ---- stock
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
  approvalId?: string;
  newAvailable?: number;
}

// ---- orders
export type OrderStatus =
  | "awaiting_dispatch"
  | "dispatched_unpaid"
  | "dispatched_partial"
  | "dispatched_paid"
  | "returned_in_transit"
  | "returned_awaiting_inspection"
  | "returned_resellable"
  | "returned_damaged"
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

// ---- analytics dashboard (mirrors the web Dashboard; all money is integer cents)
export type AnalyticsRange = "7" | "30" | "90" | "all";

export interface AnalyticsSummary {
  revenueCents: number;
  transactions: number;
  avgBasketCents: number;
}

export interface ChannelRow {
  sourceType: string; // "local" | "shopify" | "woocommerce"
  channelName: string;
  platform: string | null;
  transactions: number;
  revenueCents: number;
  avgBasketCents: number;
}

export interface TrendPoint {
  day: string; // YYYY-MM-DD
  bySource: Record<string, number>; // source_type -> revenue cents
}

export interface PaymentMethodRow {
  method: string;
  totalCents: number;
  count: number;
}

export interface TopProduct {
  id: number;
  name: string;
  unitsSold: number;
  revenueCents: number;
}

export interface StockAlertCounts {
  expiring: number;
  expired: number;
  recalled: number;
  damaged: number; // written off in 30 days + damaged returns awaiting a decision
  damagedDetail: string;
  expiryAlertDays: number;
}

export interface OrderStatusRow {
  status: string;
  count: number;
  outstandingCents: number;
}

export interface TodayOverview {
  date: string;
  posRevenueCents: number;
  onlineRevenueCents: number;
  combinedRevenueCents: number;
  posTransactions: number;
  onlineOrders: number;
  cashCollectedCents: number;
  lowStockCount: number;
  unpaidParcels: { courier: string; count: number; owedCents: number }[];
  orderStatus: OrderStatusRow[];
  stockCostValueCents: number;
  stockUnits: number;
}

export interface Analytics {
  range: AnalyticsRange;
  generatedAt: string;
  summary: AnalyticsSummary;
  previous: AnalyticsSummary | null; // same-length period just before; null for "all"
  inventoryRetailValueCents: number | null;
  channels: ChannelRow[];
  trend: TrendPoint[];
  paymentMethods: PaymentMethodRow[];
  topByChannel: Record<string, TopProduct[]>;
  overview: TodayOverview | null; // null when the caller may not see it
  stockAlerts: StockAlertCounts | null; // null when the caller may not see stock
}

// The surface the app depends on. Mock and HTTP both implement this.
export interface Api extends ApiV11, ApiV2 {
  login(req: MobileLoginRequest): Promise<LoginResult>;
  verifyOtp(req: VerifyOtpRequest): Promise<MobileLoginResponse>;
  /** Returns the whole session again: the user's permissions and the owner's app settings are refreshed with it. */
  refresh(refreshToken: string): Promise<MobileLoginResponse>;
  logout(refreshToken: string): Promise<void>;
  registerDevice(
    accessToken: string,
    body: DeviceInfo & { pushToken?: string | null },
  ): Promise<void>;
  homeAttention(accessToken: string): Promise<HomeAttention>;
  homeSummary(accessToken: string): Promise<HomeSummary>;
  appVersion(current?: string): Promise<AppVersionInfo>;

  approvals(accessToken: string, status: ApprovalStatus): Promise<Paginated<Approval>>;
  approve(accessToken: string, id: string, biometricConfirmed?: boolean): Promise<ApprovalDecisionResult>;
  reject(accessToken: string, id: string, reason: string): Promise<ApprovalDecisionResult>;

  notifications(accessToken: string, cursor?: string): Promise<Paginated<AppNotification>>;

  stockLookup(accessToken: string, q: { barcode?: string; q?: string }): Promise<StockItem[]>;
  stockAdjust(accessToken: string, req: AdjustRequest): Promise<AdjustResult>;

  orders(accessToken: string, f: OrderFilter): Promise<OrdersPage>;
  order(accessToken: string, id: number): Promise<OrderDetail>;

  analytics(accessToken: string, range: AnalyticsRange): Promise<Analytics>;
}
