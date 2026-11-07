import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockApi, mockControls } from "./mockApi";
import type { MobileLoginResponse } from "../types";

mockControls.latencyMs = 0;
const dev = { name: "t", appVersion: "1.1.0" };
const api = createMockApi();
const sign = async (u: string, p: string) => ((await api.login({ email: `${u}@urbantrends.test`, password: p, device: dev })) as MobileLoginResponse).accessToken;

test("cost and margin are absent for a manager without products.view_cost, present for the owner", async () => {
  const owner = await sign("owner", "owner123");
  const mgr = await sign("manager", "manager123");
  const o = await api.products(owner, {});
  assert.ok(o.items.every((p) => typeof p.costPriceCents === "number" && typeof p.marginCents === "number"));
  const m = await api.products(mgr, {});
  assert.ok(m.items.length > 0);
  assert.ok(m.items.every((p) => !("costPriceCents" in p) && !("marginCents" in p)), "keys must be absent, not null");
  await assert.rejects(api.updateProduct(mgr, 1, { costPriceCents: 1 }), { code: "FORBIDDEN" });
  const keeper = await sign("keeper", "keeper123");
  await assert.rejects(api.products(keeper, {}), { code: "FORBIDDEN" }); // counts stock only
});

test("price edit: reason required, price above zero, duplicate sku/barcode, history written, deactivate not delete", async () => {
  const mgr = await sign("manager", "manager123");
  await assert.rejects(api.updateProduct(mgr, 3, { sellPriceCents: 290_000 }), { code: "REASON_REQUIRED" });
  await assert.rejects(api.updateProduct(mgr, 3, { sellPriceCents: 0, reason: "testing" }), { code: "INVALID_PRICE" });
  await assert.rejects(api.updateProduct(mgr, 3, { sku: "LIN-SH-L" }), { code: "DUPLICATE_SKU" });
  await assert.rejects(api.updateProduct(mgr, 3, { barcode: "6161100010011" }), { code: "DUPLICATE_BARCODE" });
  const p = await api.updateProduct(mgr, 3, { sellPriceCents: 290_000, reason: "Supplier increase" });
  assert.equal(p.sellPriceCents, 290_000);
  const h = await api.priceHistory(mgr, 3);
  assert.deepEqual([h.items[0]?.oldPriceCents, h.items[0]?.newPriceCents, h.items[0]?.reason, h.items[0]?.source], [280_000, 290_000, "Supplier increase", "edit"]);
  const off = await api.updateProduct(mgr, 7, { isActive: false });
  assert.equal(off.isActive, false);
  assert.ok((await api.products(mgr, { active: false })).items.some((x) => x.id === 7)); // still there
  await assert.rejects(api.createProduct(mgr, { name: "x", sku: "LIN-SH-M", sellPriceCents: 1000 }), { code: "DUPLICATE_SKU" });
  await assert.rejects(api.createProduct(mgr, { name: "x", sku: "NEW-1", sellPriceCents: 1000, costPriceCents: 5 }), { code: "FORBIDDEN" });
});

test("categories: duplicate names, deactivate keeps products, reorder", async () => {
  const mgr = await sign("manager", "manager123");
  await assert.rejects(api.createCategory(mgr, "shirts"), { code: "DUPLICATE_NAME" });
  const c = await api.createCategory(mgr, "Shoes");
  const before = (await api.products(mgr, { categoryId: 1 })).items.length;
  await api.updateCategory(mgr, 1, { isActive: false });
  assert.equal((await api.products(mgr, { categoryId: 1 })).items.length, before); // products untouched
  assert.ok(!(await api.categories(mgr)).some((x) => x.id === 1));
  assert.ok((await api.categories(mgr, true)).some((x) => x.id === 1));
  await api.updateCategory(mgr, 1, { isActive: true });
  const order = await api.reorderCategories(mgr, [c.id, 3, 2, 1]);
  // reorder only moves the ids it is given (an inactive category may share a position), so compare their relative order
  assert.deepEqual(order.map((x) => x.id).filter((id) => [c.id, 3, 2, 1].includes(id)), [c.id, 3, 2, 1]);
  await assert.rejects(api.reorderCategories(mgr, [1, 1]), { code: "INVALID_ORDER" });
});

test("bulk price: needs prices.bulk; preview, apply once, stale preview refused, revert as a new batch, once", async () => {
  const mgr = await sign("manager", "manager123");
  await assert.rejects(api.bulkPreview(mgr, { categoryId: 2, mode: "percent", value: 10 }), { code: "FORBIDDEN" });
  const owner = await sign("owner", "owner123");
  const change = { categoryId: 2, mode: "percent" as const, value: 10 };
  const pv = await api.bulkPreview(owner, change);
  assert.equal(pv.count, 2);
  assert.deepEqual(pv.items.map((i) => [i.productId, i.oldPriceCents, i.newPriceCents]), [[4, 780_000, 858_000], [5, 950_000, 1_045_000]]);
  assert.equal((await api.products(owner, { categoryId: 2 })).items.find((p) => p.id === 4)?.sellPriceCents, 780_000); // preview changed nothing

  // someone reprices between preview and apply
  await api.updateProduct(owner, 5, { sellPriceCents: 960_000, reason: "Manual correction" });
  await assert.rejects(api.bulkApply(owner, change, "Season change", pv.fingerprint), { code: "PREVIEW_STALE" });
  assert.equal((await api.products(owner, { categoryId: 2 })).items.find((p) => p.id === 4)?.sellPriceCents, 780_000); // nothing applied

  const pv2 = await api.bulkPreview(owner, change);
  await assert.rejects(api.bulkApply(owner, change, "x", pv2.fingerprint), { code: "REASON_REQUIRED" });
  const applied = await api.bulkApply(owner, change, "Season change", pv2.fingerprint);
  assert.equal(applied.count, 2);
  assert.equal((await api.products(owner, { categoryId: 2 })).items.find((p) => p.id === 4)?.sellPriceCents, 858_000);

  await api.updateProduct(owner, 5, { sellPriceCents: 1_000_000, reason: "Later deliberate edit" }); // repriced since
  const rev = await api.bulkRevert(owner, applied.batchId);
  assert.equal(rev.count, 1);
  assert.deepEqual(rev.skipped.map((s) => [s.productId, s.reason]), [[5, "PRICE_CHANGED_SINCE"]]);
  assert.equal((await api.products(owner, { categoryId: 2 })).items.find((p) => p.id === 4)?.sellPriceCents, 780_000);
  assert.equal((await api.products(owner, { categoryId: 2 })).items.find((p) => p.id === 5)?.sellPriceCents, 1_000_000); // later edit survives
  await assert.rejects(api.bulkRevert(owner, applied.batchId), { code: "ALREADY_REVERTED" });
  await assert.rejects(api.bulkRevert(owner, rev.batchId), { code: "NOT_REVERTIBLE" });
  const list = await api.bulkBatches(owner);
  assert.equal(list.items[0]?.kind, "bulk_revert");
  assert.ok(list.items.find((b) => b.id === applied.batchId)?.revertedAt);
});

test("stock-take: counts survive repeated saves, resume returns the same sheet, small differences apply, big ones wait", async () => {
  const keeper = await sign("keeper", "keeper123");
  const t = await api.startStockTake(keeper, { type: "all" });
  assert.equal((await api.startStockTake(keeper, { type: "all" })).id, t.id); // resume
  // the mock has a handful of products (7 was switched off by an earlier test): count them, then re-save to prove idempotent upsert
  const ids = [1, 2, 3, 4, 5, 6];
  // system stock: 1:14 2:22 3:9 4:4 5:6 6:31. Counts are a little off, except product 4 which is far off.
  const counts: Record<number, number> = { 1: 12, 2: 20, 3: 9, 4: 4, 5: 6, 6: 30 };
  await api.saveStockTakeLines(keeper, t.id, ids.map((productId) => ({ productId, countedQty: counts[productId] as number })));
  const second = await api.saveStockTakeLines(keeper, t.id, [{ productId: 1, countedQty: 13 }, { productId: 4, countedQty: 40 }]);
  assert.equal(second.lineCount, 6); // re-sending a product replaced it, it did not add a line
  assert.equal(second.lines.find((l) => l.productId === 1)?.countedQty, 13);
  await assert.rejects(api.saveStockTakeLines(keeper, t.id, [{ productId: 999, countedQty: 1 }]), { code: "NOT_IN_SCOPE" });
  const found = await api.stockTakeProducts(keeper, t.id, { barcode: "6161100010028" });
  assert.equal(found[0]?.productId, 4);
  assert.deepEqual(await api.stockTakeProducts(keeper, t.id, {}), []);

  const res = await api.submitStockTake(keeper, t.id);
  assert.equal(res.status, "pending_approval"); // product 4: 4 -> 40 is a +36 difference
  assert.deepEqual(res.pendingApproval, [{ productId: 4, variance: 36 }]);
  assert.deepEqual(res.applied.map((a) => [a.productId, a.variance]).sort(), [[1, -1], [2, -2], [6, -1]]); // small ones applied now
  assert.equal(res.notCountedCount, 0);
  await assert.rejects(api.submitStockTake(keeper, t.id), { code: "NOT_DRAFT" });
  await assert.rejects(api.saveStockTakeLines(keeper, t.id, [{ productId: 1, countedQty: 1 }]), { code: "NOT_DRAFT" });

  await assert.rejects(api.approveStockTake(keeper, t.id), { code: "FORBIDDEN" }); // no stock.review
  const mgr = await sign("manager", "manager123");
  const done = await api.approveStockTake(mgr, t.id, "Recounted");
  assert.equal(done.status, "applied");
  assert.equal(done.lines.find((l) => l.productId === 4)?.applied, true);
  await assert.rejects(api.approveStockTake(mgr, t.id), { code: "NOT_PENDING" });
});

test("stock-take: the person who counted cannot decide their own big difference; the owner can decide another's or their own", async () => {
  const mgr = await sign("manager", "manager123");
  const owner = await sign("owner", "owner123");
  const t = await api.startStockTake(mgr, { type: "category", categoryId: 3 });
  await api.saveStockTakeLines(mgr, t.id, [{ productId: 6, countedQty: 1 }]); // 31 -> 1: a big difference
  assert.equal((await api.submitStockTake(mgr, t.id)).status, "pending_approval");
  await assert.rejects(api.approveStockTake(mgr, t.id), { code: "SELF_APPROVAL" });
  await assert.rejects(api.rejectStockTake(owner, t.id, " "), { code: "UNKNOWN" }); // a reason is required
  const rejected = await api.rejectStockTake(owner, t.id, "Count looks wrong, redo it");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.lines.find((l) => l.productId === 6)?.applied, false);

  const own = await api.startStockTake(owner, { type: "category", categoryId: 3 });
  await api.saveStockTakeLines(owner, own.id, [{ productId: 6, countedQty: 5 }]);
  await api.submitStockTake(owner, own.id);
  assert.equal((await api.approveStockTake(owner, own.id)).status, "applied");
});

test("stock-take: an empty sheet cannot be submitted, and another person's draft is not visible", async () => {
  const keeper = await sign("keeper", "keeper123");
  const owner = await sign("owner", "owner123");
  const t = await api.startStockTake(keeper, { type: "category", categoryId: 1 });
  await assert.rejects(api.submitStockTake(keeper, t.id), { code: "NO_LINES" });
  assert.ok(!(await api.stockTakes(keeper, {})).items.some((x) => x.createdBy.id !== 3)); // only their own
  assert.ok((await api.stockTakes(owner, {})).items.some((x) => x.id === t.id)); // a reviewer sees everyone's
});

test("payments: suggestions rank the equal balance first; a payment is matched once; over-balance is refused; ignore needs a reason", async () => {
  const mgr = await sign("manager", "manager123");
  const keeper = await sign("keeper", "keeper123");
  await assert.rejects(api.unmatchedPayments(keeper), { code: "FORBIDDEN" });
  const list = await api.unmatchedPayments(mgr);
  assert.equal(list.total, 3);
  assert.equal(list.unallocatedCents, 450_000 + 1_230_000 + 300_000);

  const sug = await api.paymentSuggestions(mgr, 1);
  assert.equal(sug[0]?.orderId, 501); // equal balance, and the phone is in the payment
  assert.ok(sug[0]?.reasons.includes("amount") && sug[0]?.reasons.includes("phone"));
  const byName = await api.paymentSuggestions(mgr, 2);
  assert.equal(byName[0]?.orderId, 502);
  assert.ok((await api.paymentSuggestions(mgr, 3, "Peter")).some((x) => x.orderId === 504)); // found by hand

  await assert.rejects(api.matchPayment(mgr, 2, 503), { code: "AMOUNT_EXCEEDS_BALANCE" }); // 1,230,000 against 600,000 owed
  const ok = await api.matchPayment(mgr, 1, 501);
  assert.deepEqual(ok.order, { id: 501, number: "UT123401", paymentState: "paid", balanceCents: 0 });
  await assert.rejects(api.matchPayment(mgr, 1, 504), { code: "ALREADY_MATCHED" });
  await assert.rejects(api.paymentSuggestions(mgr, 1), { code: "ALREADY_MATCHED" });
  const part = await api.matchPayment(mgr, 3, 503); // 300,000 of 600,000
  assert.deepEqual(part.order, { id: 503, number: "UT123403", paymentState: "partial", balanceCents: 300_000 });

  await assert.rejects(api.ignorePayment(mgr, 2, " "), { code: "UNKNOWN" });
  await api.ignorePayment(mgr, 2, "Refunded to the sender");
  await assert.rejects(api.ignorePayment(mgr, 2, "again again"), { code: "ALREADY_IGNORED" });
  assert.equal((await api.unmatchedPayments(mgr)).total, 0);
});

test("couriers: balances net the fees, a remittance settles parcels once, variance and limits are enforced", async () => {
  const mgr = await sign("manager", "manager123");
  const keeper = await sign("keeper", "keeper123");
  await assert.rejects(api.courierBalances(keeper), { code: "FORBIDDEN" });
  const bal = await api.courierBalances(mgr);
  assert.equal(bal[0]?.name, "Swift Riders"); // biggest first
  assert.equal(bal[0]?.outstandingCents, 450_000 + 820_000 + 310_000 - 90_000);
  assert.equal(bal[0]?.openCollections, 3);
  assert.ok((bal[0]?.overdueCents ?? 0) > 0); // the 25-day-old parcel is past 14 days

  const cols = await api.courierCollections(mgr, 11);
  assert.equal(cols.length, 3);
  const pick = [1, 2];
  const expected = 450_000 + 820_000 - 60_000;
  await assert.rejects(api.createRemittance(mgr, 11, { collectionIds: pick, remittedCents: expected + 1 }), { code: "STATEMENT_EXCEEDS_COLLECTIONS" });
  await assert.rejects(api.createRemittance(mgr, 11, { collectionIds: [4], remittedCents: 1000 }), { code: "STATEMENT_WRONG_ORGANIZATION" });
  const short = await api.createRemittance(mgr, 11, { collectionIds: pick, remittedCents: expected - 5000, reference: "MPESA-ABC" });
  assert.deepEqual([short.expectedCents, short.cashVarianceCents, short.settledCount], [expected, 5000, 2]);
  await assert.rejects(api.createRemittance(mgr, 11, { collectionIds: [2], remittedCents: 1000 }), { code: "ALREADY_SETTLED" });
  assert.equal((await api.courierCollections(mgr, 11)).length, 1); // the other parcel is still open
  const hist = await api.courierRemittances(mgr, 11);
  assert.deepEqual([hist.items[0]?.remittedCents, hist.items[0]?.feesCents, hist.items[0]?.reference], [expected - 5000, 60_000, "MPESA-ABC"]);
});

test("attendance: clock in once, clock out through the gate, and the gate's reasons are enforced", async () => {
  const keeper = await sign("keeper", "keeper123");
  assert.equal((await api.attendanceToday(keeper)).status, "not_started");
  await assert.rejects(api.clockOut(keeper, { confirmAllDispatched: true, confirmNairobiReconciled: true }), { code: "NOT_CLOCKED_IN" });
  const inn = await api.clockIn(keeper);
  assert.equal(inn.status, "clocked_in");
  assert.equal(inn.gate?.undispatchedOrders, 0);
  await assert.rejects(api.clockIn(keeper), { code: "ALREADY_CLOCKED_IN" });
  await assert.rejects(api.clockOut(keeper, {}), { code: "CLOCKOUT_CONFIRMATION_REQUIRED" });
  assert.equal((await api.attendanceToday(keeper)).status, "clocked_in"); // a refusal keeps you clocked in
  const out = await api.clockOut(keeper, { confirmAllDispatched: true, confirmNairobiReconciled: true });
  assert.equal(out.status, "clocked_out");
  await assert.rejects(api.clockOut(keeper, {}), { code: "ALREADY_CLOCKED_OUT" });

  const mgr = await sign("manager", "manager123"); // has two orders still waiting
  const s = await api.clockIn(mgr);
  assert.deepEqual([s.gate?.undispatchedOrders, s.gate?.reasonRequired, s.gate?.canConfirmDispatched], [2, true, false]);
  await assert.rejects(api.clockOut(mgr, { confirmAllDispatched: true, confirmNairobiReconciled: true }), { code: "CLOCKOUT_CONFIRMATION_FALSE" });
  await assert.rejects(api.clockOut(mgr, { confirmNairobiReconciled: true }), { code: "CLOCKOUT_REASON_REQUIRED" });
  const done = await api.clockOut(mgr, { confirmNairobiReconciled: true, handoverNotes: "Two orders wait for the courier tomorrow" });
  assert.equal(done.status, "clocked_out");
});

test("every v1.1 call is blocked offline, and an expired token is reported", async () => {
  const mgr = await sign("manager", "manager123");
  mockControls.offline = true;
  await assert.rejects(api.products(mgr, {}), { code: "NETWORK" });
  await assert.rejects(api.matchPayment(mgr, 3, 504), { code: "NETWORK" });
  await assert.rejects(api.clockIn(mgr), { code: "NETWORK" });
  mockControls.offline = false;
  mockControls.expireAccessToken = true;
  await assert.rejects(api.courierBalances(mgr), { code: "TOKEN_EXPIRED" });
});
