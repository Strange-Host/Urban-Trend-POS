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
