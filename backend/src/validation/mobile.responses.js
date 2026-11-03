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

const MobileSession = z.looseObject({
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

const Ok = z.looseObject({ ok: z.literal(true) });
const RevokeResult = z.looseObject({ ok: z.literal(true), alreadyRevoked: z.boolean() });

module.exports = {
  ErrorResponse, User, MobileSession, TwoFactorChallenge, LoginResponse, Device, AppVersion,
  AttentionItem, Attention, Summary, SummaryShop, SummaryMine, Ok, RevokeResult,
};
