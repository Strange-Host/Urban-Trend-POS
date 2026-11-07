// Drives the app's real HTTP client (src/api/http.ts) against a running backend and checks every v1 call returns what the
// app expects. It exists because the app's types are hand-written: when the server changes, this fails instead of a screen.
//
//   LIVE_BASE=http://localhost:4100 LIVE_PASSWORD=... npm run live-check
//
// Needs a server with: users admin@urbantrends.com (admin), manager@urbantrends.com (manager), cashier@urbantrends.com
// (cashier, with a pending expense they raised), store@urbantrends.com (store); a product with barcode 6161100010011; and a
// few orders. Everyone signs in with LIVE_PASSWORD. Nothing here is destructive beyond approving one expense and making
// small stock adjustments.
import assert from "node:assert/strict";
import { createHttpApi } from "../src/api/http";
import { isApiError } from "../src/api/errors";
import { parseDeepLink } from "../src/lib/deeplink";
import { isOtpChallenge, type Api, type MobileLoginResponse, type OrderStatus } from "../src/api/types";

const BASE = process.env.LIVE_BASE ?? "http://localhost:4100";
const PASSWORD = process.env.LIVE_PASSWORD ?? "Passw0rd!Passw0rd";
const api: Api = createHttpApi(BASE);
const device = { name: "Live check", appVersion: "1.0.0", platform: "android 14", deviceId: `live-check-${Date.now()}` };

type Shape = Record<string, "string" | "number" | "boolean" | "string?" | "number?" | "array" | "object" | "string|null" | "number|null">;
function shape(what: string, v: unknown, spec: Shape) {
  assert.ok(v && typeof v === "object", `${what} is not an object`);
  for (const [k, t] of Object.entries(spec)) {
    const x: unknown = (v as Record<string, unknown>)[k];
    const ok: boolean =
      t === "array" ? Array.isArray(x)
      : t === "object" ? x !== null && typeof x === "object"
      : t.endsWith("?") ? x === undefined || typeof x === t.slice(0, -1)
      : t.includes("|null") ? x === null || typeof x === t.split("|")[0]
      : typeof x === t;
    assert.ok(ok, `${what}.${k} should be ${t}, got ${JSON.stringify(x)}`);
  }
}
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return isApiError(e) ? e.code : `other:${(e as Error).message}`; } };

const sessions: Record<string, MobileLoginResponse> = {};
async function login(who: string): Promise<MobileLoginResponse> {
  const r = await api.login({ email: `${who}@urbantrends.com`, password: PASSWORD, device });
  assert.ok(!isOtpChallenge(r), `${who} unexpectedly needs a sign-in code`);
  return (sessions[who] = r);
}

const steps: { name: string; run: () => Promise<void> }[] = [];
const step = (name: string, run: () => Promise<void>) => steps.push({ name, run });

const ORDER_STATUSES: OrderStatus[] = ["awaiting_dispatch", "dispatched_unpaid", "dispatched_partial", "dispatched_paid", "returned_in_transit", "returned_awaiting_inspection", "returned_resellable", "returned_damaged", "cancelled"];

step("app version: flags, nullable link", async () => {
  const v = await api.appVersion("1.0.0");
  shape("version", v, { minimumVersion: "string", latestVersion: "string", downloadUrl: "string|null", updateRequired: "boolean", updateAvailable: "boolean" });
});

step("sign-in: wrong password is INVALID_CREDENTIALS", async () => {
  assert.equal(await code(api.login({ email: "manager@urbantrends.com", password: "nope-nope", device })), "INVALID_CREDENTIALS");
});

step("sign-in: session shape for all four roles", async () => {
  for (const [who, role] of [["admin", "admin"], ["manager", "manager"], ["cashier", "cashier"], ["store", "store"]] as const) {
    const s = await login(who);
    shape(`${who} session`, s, { accessToken: "string", refreshToken: "string", user: "object", settings: "object", sessionId: "number", sessionExpiresAt: "string" });
    shape(`${who} user`, s.user, { id: "number", name: "string", email: "string", role: "string", permissions: "array" });
    assert.equal(s.user.role, role);
    shape(`${who} settings`, s.settings, { autoLockSeconds: "number", biometricApprovalAboveCents: "number|null" });
  }
  assert.ok(sessions.admin!.user.permissions.includes("inventory.adjust"), "admin should hold every permission");
  assert.ok(!sessions.cashier!.user.permissions.includes("orders.view"), "a cashier has no orders.view by default");
});

step("refresh: rotates, returns the whole session, and a used token is REFRESH_INVALID", async () => {
  const s = await login("store");
  const r = await api.refresh(s.refreshToken);
  assert.notEqual(r.refreshToken, s.refreshToken);
  shape("refresh", r, { accessToken: "string", user: "object", settings: "object" });
  assert.equal(await code(api.refresh(s.refreshToken)), "REFRESH_INVALID");
  assert.equal(await code(api.refresh("not-a-token")), "REFRESH_INVALID");
});

step("a bad access token is TOKEN_EXPIRED (so the app refreshes and retries)", async () => {
  assert.equal(await code(api.homeSummary("not.a.jwt")), "TOKEN_EXPIRED");
});

step("device registration", async () => {
  await api.registerDevice(sessions.manager!.accessToken, { ...device, pushToken: null });
});

step("home: attention items and shop summary (manager), own-sales summary (cashier)", async () => {
  const a = await api.homeAttention(sessions.manager!.accessToken);
  shape("attention", a, { generatedAt: "string", total: "number", counts: "object", items: "array" });
  assert.ok(a.items.length > 0, "the seed has an expense waiting");
  for (const i of a.items) {
    shape("attention item", i, { id: "string", kind: "string", severity: "string", title: "string", detail: "string|null", amountCents: "number|null", since: "string|null" });
    assert.ok(i.link === null || (typeof i.link.type === "string" && typeof i.link.id === "number"));
  }
  const m = await api.homeSummary(sessions.manager!.accessToken);
  assert.equal(m.scope, "shop");
  if (m.scope === "shop") shape("shop summary", m, { totalSalesCents: "number", posSalesCount: "number", onlineOrderCount: "number", cashCollectedCents: "number", lowStockCount: "number" });
  const c = await api.homeSummary(sessions.cashier!.accessToken);
  assert.equal(c.scope, "mine");
  if (c.scope === "mine") shape("my summary", c, { mySalesCount: "number", mySalesCents: "number" });
});

step("approvals: list, string ids, reject needs a reason, approve below the limit, decided twice is applied=false", async () => {
  const tok = sessions.manager!.accessToken;
  const page = await api.approvals(tok, "pending");
  shape("approvals page", page, { items: "array", nextCursor: "string|null" });
  const exp = page.items.find((a) => a.type === "expense");
  assert.ok(exp, "the seed has a pending expense");
  shape("approval", exp, { id: "string", type: "string", status: "string", title: "string", requestedBy: "string", requestedAt: "string", amountCents: "number|null", reason: "string", items: "array", decidedBy: "string|null", decidedAt: "string|null", decisionNote: "string|null" });
  assert.match(exp!.id, /^expense:\d+$/);
  assert.equal(await code(api.reject(tok, exp!.id, "  ")), "BAD_REQUEST");
  const done = await api.approve(tok, exp!.id, false);
  assert.equal(done.applied, true);
  assert.equal(done.approval.status, "approved");
  const again = await api.approve(tok, exp!.id, false);
  assert.equal(again.applied, false);
  assert.equal(await code(api.approvals(sessions.store!.accessToken, "pending")), "FORBIDDEN");
});

step("notifications: shape, and each link opens somewhere in the app", async () => {
  const n = await api.notifications(sessions.manager!.accessToken);
  shape("notifications page", n, { items: "array", nextCursor: "string|null" });
  assert.ok(n.items.length > 0);
  for (const x of n.items) {
    shape("notification", x, { id: "number", type: "string", severity: "string", title: "string", body: "string", createdAt: "string", read: "boolean", deepLink: "string" });
    if (x.deepLink) assert.ok(/^[a-z_]+:\d+$/.test(x.deepLink), `unexpected link ${x.deepLink}`);
  }
  const withLink = n.items.find((x) => x.deepLink === "expense:1");
  if (withLink) assert.deepEqual(parseDeepLink(withLink.deepLink), { kind: "approval", id: "expense:1" });
});

step("stock: lookup unwraps to a list, adjust applies a small change, a large one waits for approval, permission is enforced", async () => {
  const tok = sessions.manager!.accessToken;
  const hit = await api.stockLookup(tok, { barcode: "6161100010011" });
  assert.ok(Array.isArray(hit) && hit.length === 1);
  shape("stock item", hit[0], { id: "number", sku: "string", barcode: "string|null", name: "string", available: "number", awaitingDispatch: "number", dispatchedUnpaid: "number", dispatchedPaid: "number", returned: "number" });
  assert.equal((await api.stockLookup(tok, { q: "linen" })).length, 1);
  assert.equal((await api.stockLookup(tok, { barcode: "0000" })).length, 0);
  const before = hit[0]!.available;
  const small = await api.stockAdjust(tok, { productId: hit[0]!.id, delta: -1, reason: "damaged", note: "live check" });
  assert.equal(small.applied, true);
  assert.equal(small.newAvailable, before - 1);
  const big = await api.stockAdjust(tok, { productId: hit[0]!.id, delta: 500, reason: "found", note: "live check" });
  assert.equal(big.applied, false);
  assert.match(big.approvalId ?? "", /^stock_adjustment:\d+$/);
  assert.equal(await code(api.stockAdjust(sessions.store!.accessToken, { productId: hit[0]!.id, delta: 1, reason: "found" })), "FORBIDDEN");
  // the owner's approval of the big one needs the phone's biometric confirmation only above the limit; it has no money amount
  const admin = sessions.admin!.accessToken;
  const dec = await api.reject(admin, big.approvalId as string, "live check, not real");
  assert.equal(dec.applied, true);
});

step("orders: list with courier facet, status filter, unpaid filter, detail", async () => {
  const tok = sessions.manager!.accessToken;
  const p = await api.orders(tok, {});
  shape("orders page", p, { items: "array", nextCursor: "string|null", couriers: "array" });
  assert.ok(p.items.length >= 3);
  for (const o of p.items) {
    shape("order", o, { id: "number", number: "string", customerName: "string", status: "string", paymentState: "string", courier: "string|null", totalCents: "number", createdAt: "string" });
    assert.ok(ORDER_STATUSES.includes(o.status), `unknown order status ${o.status}`);
  }
  assert.ok(p.couriers.includes("Rider Otieno"));
  const unpaid = await api.orders(tok, { unpaid: true });
  assert.ok(unpaid.items.length > 0 && unpaid.items.every((o) => o.status === "dispatched_unpaid" || o.status === "dispatched_partial"));
  const awaiting = await api.orders(tok, { status: "awaiting_dispatch" });
  assert.ok(awaiting.items.every((o) => o.status === "awaiting_dispatch"));
  const d = await api.order(tok, p.items[0]!.id);
  shape("order detail", d, { customerPhone: "string|null", courierPhone: "string|null", deliveryFeeCents: "number", items: "array" });
  shape("order line", d.items[0], { name: "string", qty: "number", priceCents: "number|null" });
  assert.equal(await code(api.orders(sessions.cashier!.accessToken, {})), "FORBIDDEN");
});

step("dashboard: the report endpoints answer in the shapes the app reads", async () => {
  const a = await api.analytics(sessions.admin!.accessToken, "30");
  shape("analytics", a, { range: "string", summary: "object", channels: "array", trend: "array", paymentMethods: "array", topByChannel: "object" });
  shape("summary", a.summary, { revenueCents: "number", transactions: "number", avgBasketCents: "number" });
  assert.ok(a.overview, "dashboard-overview should load for an admin");
  assert.ok(a.stockAlerts, "stock alerts should load for an admin");
  assert.ok(a.inventoryRetailValueCents !== null);
  assert.equal(await code(api.analytics(sessions.cashier!.accessToken, "30")), "FORBIDDEN");
});

step("sign-out ends the session: the access token then reads as DEVICE_REVOKED, refresh as REFRESH_INVALID", async () => {
  const s = await api.login({ email: "store@urbantrends.com", password: PASSWORD, device: { ...device, deviceId: "live-check-logout" } }) as MobileLoginResponse;
  assert.equal(await code(api.homeSummary(s.accessToken)), "ok");
  await api.logout(s.refreshToken);
  assert.equal(await code(api.homeSummary(s.accessToken)), "DEVICE_REVOKED");
  assert.equal(await code(api.refresh(s.refreshToken)), "REFRESH_INVALID");
});

(async () => {
  let failed = 0;
  for (const s of steps) {
    try {
      await s.run();
      console.log(`PASS  ${s.name}`);
    } catch (e) {
      failed += 1;
      console.log(`FAIL  ${s.name}\n      ${(e as Error).message.split("\n").join("\n      ")}`);
    }
  }
  console.log(`\n${steps.length - failed}/${steps.length} steps passed against ${BASE}`);
  process.exit(failed ? 1 : 0);
})();
