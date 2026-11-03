import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockApi, mockControls } from "./mockApi";

mockControls.latencyMs = 0;
const dev = { name: "t", appVersion: "0.1.0" };

test("login, bad password, rotation and replay", async () => {
  const api = createMockApi();
  await assert.rejects(api.login({ username: "owner", password: "x", device: dev }), { code: "INVALID_CREDENTIALS" });
  const l = await api.login({ username: "owner", password: "owner123", device: dev });
  const a = await api.homeAttention(l.accessToken);
  assert.equal(a.items[0]?.kind, "approvals");
  const r1 = await api.refresh(l.refreshToken);
  await assert.rejects(api.refresh(l.refreshToken), { code: "REFRESH_INVALID" }); // replay
  await assert.rejects(api.refresh(r1.refreshToken), { code: "REFRESH_INVALID" }); // family killed
});

test("expired token, revoke, offline, role routing", async () => {
  const api = createMockApi();
  const l = await api.login({ username: "manager", password: "manager123", device: dev });
  const a = await api.homeAttention(l.accessToken);
  assert.ok(!a.items.some((i) => i.kind === "unmatched_payments")); // owner-only
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
  const o = await api.login({ username: "owner", password: "owner123", device: dev });
  const pending = await api.approvals(o.accessToken, "pending");
  assert.equal(pending.items.length >= 3, true);
  await assert.rejects(api.reject(o.accessToken, 1, "  "), { code: "UNKNOWN" }); // reason required
  const r = await api.reject(o.accessToken, 1, "Not valid");
  assert.equal(r.applied, true);
  const again = await api.approve(o.accessToken, 1);
  assert.equal(again.applied, false); // already decided: no change
  assert.equal(again.approval.status, "rejected");
  mockControls.alreadyDecided = true;
  const raced = await api.approve(o.accessToken, 2);
  assert.equal(raced.applied, false);
  assert.equal(raced.approval.decidedBy, "Wanjiru");
});

test("stock: lookup, adjust threshold, permission", async () => {
  const api = createMockApi();
  const o = await api.login({ username: "owner", password: "owner123", device: dev });
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
  const m = await api.login({ username: "manager", password: "manager123", device: dev });
  await assert.rejects(api.stockAdjust(m.accessToken, { productId: 1, delta: 1, reason: "found" }), { code: "FORBIDDEN" });
});

test("orders: filter and paginate", async () => {
  const api = createMockApi();
  const o = await api.login({ username: "owner", password: "owner123", device: dev });
  const p1 = await api.orders(o.accessToken, {});
  assert.equal(p1.items.length, 10);
  assert.ok(p1.nextCursor);
  const p2 = await api.orders(o.accessToken, { cursor: p1.nextCursor as string });
  assert.notEqual(p2.items[0]?.id, p1.items[0]?.id);
  const unpaid = await api.orders(o.accessToken, { unpaid: true });
  assert.ok(unpaid.items.every((x) => x.paymentState !== "paid"));
  const d = await api.order(o.accessToken, 1002);
  assert.ok(d.items.length > 0);
});
