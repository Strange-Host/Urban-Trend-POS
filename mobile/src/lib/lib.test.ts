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
  assert.deepEqual(parseDeepLink("payments/unmatched"), { kind: "route", name: "Payments" }); // built in v1.1
});

test("phone helpers", () => {
  assert.equal(toInternational("0712 345 678"), "254712345678");
  assert.equal(toInternational("+254 712 345 678"), "254712345678");
  assert.equal(toInternational("712345678"), "254712345678");
  assert.equal(toInternational("123"), null);
  assert.equal(whatsappUrl("0712345678"), "https://wa.me/254712345678");
  assert.equal(telUrl("0712 345 678"), "tel:0712345678");
});

import { buildBars, channelTotals, compact, deltaPct, isoDay, niceMax, rangeWindow } from "./analytics";
import { can } from "./permissions";

test("compact", () => {
  assert.equal(compact(0), "0");
  assert.equal(compact(999), "999");
  assert.equal(compact(1000), "1K");
  assert.equal(compact(45_300), "45.3K");
  assert.equal(compact(1_234_567), "1.2M");
  assert.equal(compact(-2_500), "-2.5K");
});

test("deltaPct and niceMax", () => {
  assert.equal(deltaPct(120, 100), 20);
  assert.equal(deltaPct(80, 100), -20);
  assert.equal(deltaPct(50, 0), null); // nothing to compare against
  assert.equal(deltaPct(50, null), null);
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(730), 1000);
  assert.equal(niceMax(2_100), 2_500);
  assert.equal(niceMax(4_000), 5_000);
});

test("rangeWindow", () => {
  const now = new Date(2026, 10, 4); // 4 Nov 2026, local
  assert.deepEqual(rangeWindow("30", now), { from: "2026-10-05", prevFrom: "2026-09-05", prevTo: "2026-10-04" });
  assert.deepEqual(rangeWindow("all", now), { from: "1970-01-01", prevFrom: null, prevTo: null });
});

test("buildBars: daily fills empty days, weekly and monthly group", () => {
  const now = new Date(2026, 10, 4);
  const daily = buildBars([{ day: "2026-11-03", bySource: { local: 100, shopify: 50 } }], "7", now);
  assert.equal(daily.length, 8);
  assert.equal(daily[daily.length - 2]?.total, 150);
  assert.equal(daily[daily.length - 1]?.total, 0);

  const trend = [
    { day: "2026-10-26", bySource: { local: 10 } }, // Monday
    { day: "2026-11-01", bySource: { local: 5 } }, // Sunday, same ISO week
    { day: "2026-11-02", bySource: { local: 7 } }, // next Monday
  ];
  const weekly = buildBars(trend, "90", now);
  assert.deepEqual(weekly.map((b) => b.total), [15, 7]);
  const monthly = buildBars(trend, "all", now);
  assert.deepEqual(monthly.map((b) => b.total), [10, 12]); // Oct, Nov
  assert.equal(isoDay(new Date(2026, 0, 5)), "2026-01-05");
});

test("channelTotals drops empty channels", () => {
  const rows = [
    { sourceType: "local", channelName: "a", platform: null, transactions: 1, revenueCents: 100, avgBasketCents: 100 },
    { sourceType: "local", channelName: "b", platform: null, transactions: 1, revenueCents: 50, avgBasketCents: 50 },
    { sourceType: "shopify", channelName: "c", platform: "shopify", transactions: 0, revenueCents: 0, avgBasketCents: 0 },
  ];
  assert.deepEqual(channelTotals(rows), [{ sourceType: "local", revenueCents: 150 }]);
});

test("can: owner always, others by key", () => {
  const u = (role: "owner" | "manager", permissions: string[]) => ({ id: 1, name: "x", username: "x", role, permissions });
  assert.equal(can(u("owner", []), "reports.view"), true);
  assert.equal(can(u("manager", ["reports.view"]), "reports.view"), true);
  assert.equal(can(u("manager", ["orders.view"]), "reports.view"), false);
  assert.equal(can(u("manager", ["a"]), ["b", "a"]), true);
  assert.equal(can(null, "reports.view"), false);
});
