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

import { parseDeepLink } from "./deeplink";
import { toInternational, whatsappUrl, telUrl } from "./phone";

test("parseDeepLink", () => {
  assert.deepEqual(parseDeepLink("approvals"), { kind: "tab", tab: "Approvals" });
  assert.deepEqual(parseDeepLink("approvals/3"), { kind: "approval", id: 3 });
  assert.deepEqual(parseDeepLink("orders/1004"), { kind: "order", id: 1004 });
  const o = parseDeepLink("orders?unpaid=1");
  assert.equal(o?.kind === "tab" && o.tab, "Orders");
  assert.deepEqual(parseDeepLink("stock?alerts=1"), { kind: "tab", tab: "Stock" });
  assert.equal(parseDeepLink("payments/unmatched"), null);
});

test("phone helpers", () => {
  assert.equal(toInternational("0712 345 678"), "254712345678");
  assert.equal(toInternational("+254 712 345 678"), "254712345678");
  assert.equal(toInternational("712345678"), "254712345678");
  assert.equal(toInternational("123"), null);
  assert.equal(whatsappUrl("0712345678"), "https://wa.me/254712345678");
  assert.equal(telUrl("0712 345 678"), "tel:0712345678");
});
