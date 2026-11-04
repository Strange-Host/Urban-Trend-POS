const { z } = require('zod');

// What the /api/v1 endpoints SEND BACK, written as zod schemas so the OpenAPI document (openapi/v1.js) and the typed
// client for the app are generated from the same place the tests check against.
//
// Every object is z.looseObject: extra fields are allowed. That is the whole API contract in one line - the server may
// ADD fields to a response without breaking an installed app, so a schema that rejected unknown fields would fail the
// first time one is added. What these schemas DO pin down is the opposite direction: a field listed here can never
// disappear or change type without the contract tests failing, which is exactly the change that would break phones.

const iso = z.string().describe('ISO-8601 UTC timestamp');
const cents = z.number().int().describe('Money in the smallest KES unit (cents)');

const ErrorResponse = z.looseObject({
  error: z.looseObject({ code: z.string(), message: z.string() }),
  details: z.unknown().optional(),
}).describe('Every error: a stable machine-readable code and a message that is safe to show');

const User = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  role: z.enum(['admin', 'manager', 'cashier', 'store']),
  store_id: z.number().int().nullable(),
  permissions: z.array(z.string()).describe('What this person may do; the server re-checks on every request'),
});

// What the owner has set that the app must obey: how long before it locks, and above what amount an approval needs the
// fingerprint / face check. Sent with every sign-in and refresh, so a change reaches phones within minutes.
const AppSettings = z.looseObject({
  autoLockSeconds: z.number().int(),
  biometricApprovalAboveCents: cents.nullable().describe('null = never ask'),
});

const MobileSession = z.looseObject({
  settings: AppSettings.optional(),
  token: z.string().describe('Short-lived access token (send as "Authorization: Bearer ...")'),
  refreshToken: z.string().describe('Single-use refresh token. Keep it in the Android Keystore. Each refresh returns a new one'),
  user: User,
  session: z.looseObject({ id: z.number().int(), expiresAt: iso.describe('The hard end of this sign-in, however active the phone is') }),
});

const TwoFactorChallenge = z.looseObject({
  twoFactorRequired: z.literal(true),
  challengeToken: z.string(),
  phoneHint: z.string().describe('The number the code was sent to, partly hidden'),
  expiresInSeconds: z.number().int(),
});

const LoginResponse = z.union([MobileSession, TwoFactorChallenge])
  .describe('A signed-in session, or (when the account uses sign-in codes) a challenge to answer at /auth/mobile/verify-otp');

const Device = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  platform: z.string().nullable(),
  appVersion: z.string().nullable(),
  current: z.boolean().describe('True for the phone making this request'),
  pushEnabled: z.boolean(),
  signedInAt: iso,
  lastSeenAt: iso,
  expiresAt: iso,
  user: z.looseObject({ id: z.number().int(), name: z.string() }).optional().describe('Only in the admin list of every phone'),
});

const AppVersion = z.looseObject({
  minimumVersion: z.string(),
  latestVersion: z.string(),
  downloadUrl: z.string().nullable(),
  updateRequired: z.boolean().describe('Below the minimum: show a blocking update screen'),
  updateAvailable: z.boolean().describe('Below the latest: offer the update'),
});

const AttentionItem = z.looseObject({
  id: z.string().describe('Stable per item, e.g. "approval_request:12"'),
  kind: z.string(),
  severity: z.enum(['info', 'warning', 'urgent']),
  title: z.string(),
  detail: z.string().nullable(),
  amountCents: cents.nullable(),
  since: iso.nullable(),
  link: z.looseObject({ type: z.string(), id: z.number().int() }).nullable().describe('Where tapping the item goes'),
});

const Attention = z.looseObject({
  generatedAt: iso,
  total: z.number().int().describe('Everything waiting on this person, including items beyond the 50 sent'),
  counts: z.record(z.string(), z.number().int()).describe('How many of each kind'),
  items: z.array(AttentionItem),
});

const SummaryShop = z.looseObject({
  scope: z.literal('shop'),
  generatedAt: iso, date: z.string(), currency: z.string(),
  posSalesCents: cents, posSalesCount: z.number().int(),
  onlineSalesCents: cents, onlineOrderCount: z.number().int(),
  totalSalesCents: cents, cashCollectedCents: cents,
  lowStockCount: z.number().int(), attentionCount: z.number().int(),
});
const SummaryMine = z.looseObject({
  scope: z.literal('mine'),
  generatedAt: iso, date: z.string(), currency: z.string(),
  mySalesCount: z.number().int(), mySalesCents: cents,
});
const Summary = z.discriminatedUnion('scope', [SummaryShop, SummaryMine])
  .describe('Whole-shop figures for people who may see reports; otherwise only your own sales today. Never cost or profit');

// ---- approvals, alerts, stock, orders, preferences ----------------------------------------------------------------------
const ApprovalLine = z.looseObject({ name: z.string(), qty: z.number().int(), priceCents: cents.nullable() });
const Approval = z.looseObject({
  id: z.string().describe('"<type>:<number>", e.g. "void:12"'),
  type: z.enum(['void', 'refund', 'expense', 'requisition', 'stock_adjustment']),
  status: z.enum(['pending', 'approved', 'rejected']),
  title: z.string(),
  requestedBy: z.string(), requestedAt: iso,
  amountCents: cents.nullable(),
  reason: z.string(),
  items: z.array(ApprovalLine),
  decidedBy: z.string().nullable(), decidedAt: iso.nullable(), decisionNote: z.string().nullable(),
});
const ApprovalsPage = z.looseObject({ items: z.array(Approval), nextCursor: z.string().nullable() });
const ApprovalDecision = z.looseObject({
  applied: z.boolean().describe('false = someone else decided first; `approval` is their decision and nothing changed'),
  approval: Approval,
});

const NotificationItem = z.looseObject({
  id: z.number().int(), type: z.string(), severity: z.enum(['info', 'warning', 'urgent']), title: z.string(), body: z.string(),
  createdAt: iso, read: z.boolean(), deepLink: z.string().describe('"<entity>:<id>" or empty'),
});
const NotificationsPage = z.looseObject({ items: z.array(NotificationItem), nextCursor: z.string().nullable() });

const StockItem = z.looseObject({
  id: z.number().int(), sku: z.string(), barcode: z.string().nullable(), name: z.string(),
  available: z.number().int(), awaitingDispatch: z.number().int(), dispatchedUnpaid: z.number().int(),
  dispatchedPaid: z.number().int(), returned: z.number().int(),
});
const StockLookup = z.looseObject({ items: z.array(StockItem) });
const AdjustResult = z.looseObject({
  applied: z.boolean().describe('false = it is large, so it was not applied: it waits for the owner (approvalId)'),
  approvalId: z.string().optional(), newAvailable: z.number().int().optional(),
});

const OrderStatus = z.enum(['awaiting_dispatch', 'dispatched_unpaid', 'dispatched_partial', 'dispatched_paid', 'returned_in_transit',
  'returned_awaiting_inspection', 'returned_resellable', 'returned_damaged', 'cancelled']);
const OrderSummary = z.looseObject({
  id: z.number().int(), number: z.string(), customerName: z.string(), status: OrderStatus,
  paymentState: z.enum(['paid', 'unpaid', 'partial']), courier: z.string().nullable(), totalCents: cents, createdAt: iso,
});
const OrdersPage = z.looseObject({ items: z.array(OrderSummary), nextCursor: z.string().nullable(), couriers: z.array(z.string()) });
const OrderDetail = OrderSummary.extend({
  customerPhone: z.string().nullable(), courierPhone: z.string().nullable(), deliveryFeeCents: cents,
  items: z.array(ApprovalLine), notes: z.string().optional(),
});

const Preferences = z.looseObject({
  quietHours: z.looseObject({ enabled: z.boolean(), start: z.string(), end: z.string() }),
});

const DownloadLink = z.looseObject({ url: z.string(), expiresAt: iso, version: z.string() });
const ApkUpload = z.looseObject({ version: z.string(), sizeBytes: z.number().int(), latestVersion: z.string() });

const Ok = z.looseObject({ ok: z.literal(true) });
const RevokeResult = z.looseObject({ ok: z.literal(true), alreadyRevoked: z.boolean() });

module.exports = {
  ErrorResponse, User, MobileSession, TwoFactorChallenge, LoginResponse, Device, AppVersion,
  AttentionItem, Attention, Summary, SummaryShop, SummaryMine, Ok, RevokeResult,
  AppSettings, Approval, ApprovalsPage, ApprovalDecision, NotificationsPage, StockLookup, AdjustResult, OrdersPage, OrderDetail, Preferences,
  DownloadLink, ApkUpload,
};
