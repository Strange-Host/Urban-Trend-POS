import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockApi, mockControls, OTP_CODE } from "./mockApi";
import { isOtpChallenge, type Api, type MobileLoginResponse } from "../types";

mockControls.latencyMs = 0;
const dev = { name: "t", appVersion: "0.1.0" };
async function signIn(api: Api, who: string, password = `${who}123`): Promise<MobileLoginResponse> {
  const r = await api.login({ email: `${who}@urbantrends.test`, password, device: dev });
  assert.ok(!isOtpChallenge(r), "this account should sign in without a code");
  return r;
}

test("login, bad password, rotation and replay", async () => {
  const api = createMockApi();
  await assert.rejects(api.login({ email: "owner@urbantrends.test", password: "x", device: dev }), { code: "INVALID_CREDENTIALS" });
  const l = await signIn(api, "owner", "owner123");
  const a = await api.homeAttention(l.accessToken);
  assert.equal(a.items[0]?.kind, "approval_request");
  assert.equal(a.total, a.items.length);
  assert.equal(l.user.role, "admin");
  assert.equal(l.settings.biometricApprovalAboveCents, 500_000);
  const r1 = await api.refresh(l.refreshToken);
  await assert.rejects(api.refresh(l.refreshToken), { code: "REFRESH_INVALID" }); // replay
  await assert.rejects(api.refresh(r1.refreshToken), { code: "REFRESH_INVALID" }); // family killed
});

test("expired token, revoke, offline, role routing", async () => {
  const api = createMockApi();
  const l = await signIn(api, "manager", "manager123");
  const a = await api.homeAttention(l.accessToken);
  assert.ok(!a.items.some((i) => i.kind === "unmatched_payment")); // owner-only
  mockControls.expireAccessToken = true;
  await assert.rejects(api.homeSummary(l.accessToken), { code: "TOKEN_EXPIRED" });
  mockControls.revokeDevice = true;
  await assert.rejects(api.homeSummary(l.accessToken), { code: "DEVICE_REVOKED" });
  mockControls.revokeDevice = false;
  mockControls.offline = true;
  await assert.rejects(api.appVersion(), { code: "NETWORK" });
  mockControls.offline = false;
});

test("approvals: decide, conflict, forbidden", async () => {
  const api = createMockApi();
  const o = await signIn(api, "owner", "owner123");
  const pending = await api.approvals(o.accessToken, "pending");
  assert.equal(pending.items.length >= 3, true);
  await assert.rejects(api.reject(o.accessToken, "void:1", "  "), { code: "UNKNOWN" }); // reason required
  const r = await api.reject(o.accessToken, "void:1", "Not valid");
  assert.equal(r.applied, true);
  const again = await api.approve(o.accessToken, "void:1");
  assert.equal(again.applied, false); // already decided: no change
  assert.equal(again.approval.status, "rejected");
  mockControls.alreadyDecided = true;
  const raced = await api.approve(o.accessToken, "void:2", true);
  assert.equal(raced.applied, false);
  assert.equal(raced.approval.decidedBy, "Wanjiru");
});

test("stock: lookup, adjust threshold, permission", async () => {
  const api = createMockApi();
  const o = await signIn(api, "owner", "owner123");
  const hit = await api.stockLookup(o.accessToken, { barcode: "6161100010011" });
  assert.equal(hit[0]?.name, "Linen shirt L");
  assert.equal((await api.stockLookup(o.accessToken, { barcode: "000" })).length, 0);
  const small = await api.stockAdjust(o.accessToken, { productId: 1, delta: -2, reason: "damaged" });
  assert.equal(small.applied, true);
  assert.equal(small.newAvailable, 12);
  const big = await api.stockAdjust(o.accessToken, { productId: 3, delta: 25, reason: "found" });
  assert.equal(big.applied, false);
  assert.ok(big.approvalId);
  await assert.rejects(api.stockAdjust(o.accessToken, { productId: 1, delta: -999, reason: "lost" }), { code: "UNKNOWN" });
  const m = await signIn(api, "keeper", "keeper123"); // counts and receives stock, but may not adjust it
  await assert.rejects(api.stockAdjust(m.accessToken, { productId: 1, delta: 1, reason: "found" }), { code: "FORBIDDEN" });
});

test("orders: filter and paginate", async () => {
  const api = createMockApi();
  const o = await signIn(api, "owner", "owner123");
  const p1 = await api.orders(o.accessToken, {});
  assert.equal(p1.items.length, 10);
  assert.ok(p1.nextCursor);
  const p2 = await api.orders(o.accessToken, { cursor: p1.nextCursor as string });
  assert.notEqual(p2.items[0]?.id, p1.items[0]?.id);
  const unpaid = await api.orders(o.accessToken, { unpaid: true });
  assert.ok(unpaid.items.length > 0 && unpaid.items.every((x) => x.status === "dispatched_unpaid" || x.status === "dispatched_partial"));
  const d = await api.order(o.accessToken, 1002);
  assert.equal(d.status, "dispatched_partial");
  assert.ok(d.items.length > 0);
});

test("analytics: shape, ranges and permission", async () => {
  const api = createMockApi();
  const o = await signIn(api, "owner", "owner123");
  const a30 = await api.analytics(o.accessToken, "30");
  assert.equal(a30.range, "30");
  assert.equal(a30.trend.length, 31); // today plus the 30 days before it
  assert.ok(a30.summary.revenueCents > 0 && a30.previous && a30.previous.revenueCents > 0);
  assert.ok(a30.channels.length === 3 && a30.overview && a30.stockAlerts);
  const channelSum = a30.channels.reduce((s, c) => s + c.revenueCents, 0);
  assert.equal(channelSum, a30.summary.revenueCents); // the cards agree with the headline number
  const all = await api.analytics(o.accessToken, "all");
  assert.equal(all.previous, null);
  assert.ok(all.summary.revenueCents > a30.summary.revenueCents);
});

test("a sign-in code account answers with a challenge, and only the right code signs in", async () => {
  const api = createMockApi();
  const c = await api.login({ email: "otp@urbantrends.test", password: "otp123", device: dev });
  assert.ok(isOtpChallenge(c));
  if (!isOtpChallenge(c)) return;
  await assert.rejects(api.verifyOtp({ challengeToken: c.challengeToken, code: "000000", device: dev }), { code: "INVALID_CREDENTIALS" });
  const s = await api.verifyOtp({ challengeToken: c.challengeToken, code: OTP_CODE, device: dev });
  assert.equal(s.user.name, "Amina");
  await assert.rejects(api.verifyOtp({ challengeToken: c.challengeToken, code: OTP_CODE, device: dev }), { code: "INVALID_CREDENTIALS" }); // one use
});

test("an approval at or above the owner's limit needs the phone's biometric confirmation, like the server", async () => {
  const api = createMockApi();
  const o = await signIn(api, "owner");
  await assert.rejects(api.approve(o.accessToken, "refund:3"), { code: "BIOMETRIC_REQUIRED" }); // KES 10,800
  const ok = await api.approve(o.accessToken, "refund:3", true);
  assert.equal(ok.applied, true);
  const adj = await api.stockAdjust(o.accessToken, { productId: 3, delta: 30, reason: "found" }); // waits for approval, no amount on it
  const small = await api.approve(o.accessToken, adj.approvalId as string); // below the limit: no biometric needed
  assert.equal(small.applied, true);
});

test("screens are gated by the server's own permission names", async () => {
  const api = createMockApi();
  const k = await signIn(api, "keeper"); // counts and receives stock only
  await assert.rejects(api.approvals(k.accessToken, "pending"), { code: "FORBIDDEN" });
  await assert.rejects(api.orders(k.accessToken, {}), { code: "FORBIDDEN" });
  assert.ok((await api.stockLookup(k.accessToken, { q: "linen" })).length > 0);
  const s = await api.homeSummary(k.accessToken);
  assert.equal(s.scope, "mine");
  const o = await signIn(api, "owner");
  assert.equal((await api.homeSummary(o.accessToken)).scope, "shop");
});

test("app version: the server's flags decide", async () => {
  const api = createMockApi();
  mockControls.forceUpdate = true;
  assert.equal((await api.appVersion("0.1.0")).updateRequired, true);
  mockControls.forceUpdate = false;
  const v = await api.appVersion("0.1.0");
  assert.equal(v.updateRequired, false);
  assert.equal(v.updateAvailable, false);
});
