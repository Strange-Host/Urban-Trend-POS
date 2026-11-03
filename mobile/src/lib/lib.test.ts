import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, formatAmount, formatKes, timeAgo } from "./format";
import { shouldLock } from "./lock";

test("formatAmount", () => {
  assert.equal(formatAmount(14_230_000), "142,300");
  assert.equal(formatAmount(-20_000), "-200");
  assert.equal(formatAmount(0), "0");
  assert.equal(formatKes(1_840_000), "KES 18,400");
});

test("timeAgo", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  assert.equal(timeAgo("2026-11-03T11:58:00Z", now), "2 min ago");
  assert.equal(timeAgo("2026-11-03T11:59:50Z", now), "just now");
  assert.equal(timeAgo("2026-11-03T08:00:00Z", now), "4 h ago");
});

test("compareVersions", () => {
  assert.ok(compareVersions("0.1.0", "0.2.0") < 0);
  assert.ok(compareVersions("1.0", "0.9.9") > 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
});

test("shouldLock", () => {
  assert.equal(shouldLock(null, 1_000_000, 120), false);
  assert.equal(shouldLock(0, 119_000, 120), false);
  assert.equal(shouldLock(0, 120_000, 120), true);
});
