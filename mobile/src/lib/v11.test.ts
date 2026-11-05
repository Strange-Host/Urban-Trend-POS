import assert from "node:assert/strict";
import { test } from "node:test";
import { describeChange, newPrice, planBulk, toShilling } from "./bulkPrice";
import { centsToInput, parseKesToCents } from "./money";
import { exceedsCollections, remittanceVariance, selectionTotals } from "./remittance";
import { draftKey, markSaved, mergeDraft, needsApproval, pendingBatches, summarize, varianceOf, type LocalLine } from "./stockTake";
import { parseDeepLink } from "./deeplink";
import type { CourierCollection, StockTakeLine } from "../api/typesV11";

test("money: parses shillings to cents and back, refuses junk", () => {
  assert.equal(parseKesToCents("1,250.5"), 125050);
  assert.equal(parseKesToCents("300"), 30000);
  assert.equal(parseKesToCents(" 0.05 "), 5);
  for (const bad of ["", "abc", "1.234", "-5", "1,2,3x", "."]) assert.equal(parseKesToCents(bad), null, bad);
  assert.equal(centsToInput(125050), "1250.50");
  assert.equal(centsToInput(30000), "300");
  assert.equal(parseKesToCents(centsToInput(125005)), 125005);
});

test("bulk price: nearest whole shilling, halves up, same as the server", () => {
  assert.equal(newPrice(100000, "percent", 5), 105000);
  assert.equal(newPrice(99900, "percent", 10), 109900);
  assert.equal(newPrice(25000, "percent", 5), 26300); // 26250 is exactly half a shilling -> up
  assert.equal(newPrice(10050, "fixed", 0), 10100);
  assert.equal(newPrice(100000, "fixed", -2500), 97500);
  assert.equal(newPrice(100000, "percent", -7.5), 92500);
  assert.equal(toShilling(149), 100);
  assert.equal(toShilling(150), 200);
});

test("bulk price: skips zero-or-less and unchanged, reports the rest with deltas", () => {
  const products = [
    { id: 1, name: "A", sku: "a", sellPriceCents: 100000 },
    { id: 2, name: "B", sku: "b", sellPriceCents: 5000 },
    { id: 3, name: "C", sku: "c", sellPriceCents: 40000 },
  ];
  const down = planBulk(products, { mode: "fixed", value: -5000 });
  assert.deepEqual(down.skipped, [{ productId: 2, name: "B", reason: "PRICE_NOT_POSITIVE" }]);
  assert.deepEqual(down.items.map((i) => [i.productId, i.newPriceCents, i.deltaCents]), [[1, 95000, -5000], [3, 35000, -5000]]);
  const none = planBulk(products, { mode: "percent", value: 0 });
  assert.equal(none.items.length, 0);
  assert.ok(none.skipped.every((s) => s.reason === "UNCHANGED"));
});

test("bulk price: describes a change for a list", () => {
  assert.equal(describeChange("percent", 10), "+10%");
  assert.equal(describeChange("percent", -7.5), "-7.5%");
  assert.equal(describeChange("fixed", -5000), "-KES 50");
  assert.equal(describeChange("fixed", 20000), "+KES 200");
  assert.equal(describeChange("revert", 0), "Revert");
});

const sline = (id: number, counted: number, system = 5): StockTakeLine => ({ productId: id, name: `P${id}`, sku: `s${id}`, barcode: null, countedQty: counted, systemQty: system, variance: counted - system, needsApproval: false, applied: false });
const lline = (id: number, counted: number, dirty: boolean, system = 5): LocalLine => ({ productId: id, name: `P${id}`, sku: `s${id}`, barcode: null, countedQty: counted, systemQty: system, dirty });

test("stock-take: variance and the approval limit", () => {
  assert.equal(varianceOf(7, 10), -3);
  assert.equal(needsApproval(-10, 10), false);
  assert.equal(needsApproval(-11, 10), true);
  assert.equal(needsApproval(11, 10), true);
  assert.equal(needsApproval(0, 0), false);
});

test("stock-take: a change not yet saved survives a reload; the server wins otherwise; phone-only lines are kept", () => {
  const server = [sline(1, 5), sline(2, 9), sline(3, 1)];
  const local = [lline(1, 8, true), lline(2, 4, false), lline(4, 2, true)];
  const merged = mergeDraft(server, local);
  const by = Object.fromEntries(merged.map((l) => [l.productId, l]));
  assert.equal(by[1]!.countedQty, 8); assert.equal(by[1]!.dirty, true);    // unsaved phone edit wins
  assert.equal(by[2]!.countedQty, 9); assert.equal(by[2]!.dirty, false);   // saved phone copy: server is the truth
  assert.equal(by[3]!.countedQty, 1);                                       // only on the server
  assert.equal(by[4]!.countedQty, 2); assert.equal(by[4]!.dirty, true);    // only on the phone: kept, still to send
  assert.equal(merged.length, 4);
});

test("stock-take: 100 lines are saved in batches, and an edit made while saving stays pending", () => {
  const lines = Array.from({ length: 100 }, (_, i) => lline(i + 1, i, true));
  const batches = pendingBatches(lines, 40);
  assert.deepEqual(batches.map((b) => b.length), [40, 40, 20]);
  assert.equal(pendingBatches(lines.map((l) => ({ ...l, dirty: false }))).length, 0);

  const sent = batches[0]!;
  const edited = lines.map((l) => (l.productId === 1 ? { ...l, countedQty: 99 } : l)); // changed again while the save was in flight
  const after = markSaved(edited, sent);
  assert.equal(after.find((l) => l.productId === 1)!.dirty, true);
  assert.equal(after.find((l) => l.productId === 2)!.dirty, false);
  assert.equal(after.find((l) => l.productId === 41)!.dirty, true); // not part of this batch
});

test("stock-take: summary counts short, over, matching and what needs approval", () => {
  const s = summarize([{ countedQty: 2, systemQty: 14 }, { countedQty: 9, systemQty: 6 }, { countedQty: 4, systemQty: 4 }], 10);
  assert.deepEqual(s, { counted: 3, unitsShort: 12, unitsOver: 3, matching: 1, needsApproval: 1 });
  assert.equal(draftKey(7, 12), "ut.stocktake.draft.v1.7.12");
});

const col = (id: number, amount: number, fee: number): CourierCollection => ({ collectionId: id, orderId: id, orderNumber: `UT${id}`, customerName: "x", amountCents: amount, feeCents: fee, collectedOn: "2026-11-01" });

test("remittance: expected cash is collections minus fees for the ticked parcels only", () => {
  const all = [col(1, 200000, 20000), col(2, 100000, 10000), col(3, 50000, 5000)];
  const t = selectionTotals(all, new Set([1, 2]));
  assert.deepEqual(t, { count: 2, collectionsCents: 300000, feesCents: 30000, expectedCents: 270000 });
  assert.equal(selectionTotals(all, new Set()).expectedCents, 0);
  assert.deepEqual(remittanceVariance(270000, 270000), { diffCents: 0, kind: "exact" });
  assert.deepEqual(remittanceVariance(265000, 270000), { diffCents: 5000, kind: "short" });
  assert.deepEqual(remittanceVariance(275000, 270000), { diffCents: -5000, kind: "over" });
  assert.equal(exceedsCollections(270001, t), true);
  assert.equal(exceedsCollections(270000, t), false);
});

test("deep links: v1.1 screens", () => {
  assert.deepEqual(parseDeepLink("payments/unmatched"), { kind: "route", name: "Payments" });
  assert.deepEqual(parseDeepLink("payments"), { kind: "route", name: "Payments" });
  assert.deepEqual(parseDeepLink("catalog"), { kind: "route", name: "Catalog" });
  assert.deepEqual(parseDeepLink("stock-takes"), { kind: "route", name: "StockTakes" });
  assert.deepEqual(parseDeepLink("stock-takes/12"), { kind: "route", name: "StockTakeDetail", params: { id: 12 } });
  assert.deepEqual(parseDeepLink("couriers"), { kind: "route", name: "Couriers" });
  assert.deepEqual(parseDeepLink("attendance"), { kind: "route", name: "Attendance" });
  assert.equal(parseDeepLink("nonsense"), null);
  // the existing ones still work
  assert.deepEqual(parseDeepLink("stock?alerts=1"), { kind: "tab", tab: "Stock" });
});
