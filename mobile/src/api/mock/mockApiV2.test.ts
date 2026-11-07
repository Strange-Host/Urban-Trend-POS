import assert from "node:assert/strict";
import { test } from "node:test";
import { isApiError } from "../errors";
import { createMockApi } from "./mockApi";
import { countdown, callbackChoices, followUpIn, isDueToday } from "../../lib/telesales";

const api = createMockApi();
const login = async (u: string, p = u + "123") => (await api.login({ username: u, password: p, deviceName: "t", platform: "android" } as never)).accessToken;
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return isApiError(e) ? e.code : "other"; } };
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

test("agent sees only their own waiting orders, oldest first; someone else's order is a 404", async () => {
  const t = await login("agent", "agent123");
  const list = await api.telesalesOrders(t);
  assert.deepEqual(list.items.map((o) => o.number), ["UT-1041", "UT-1042", "UT-1043"]);
  assert.equal(list.total, 3);
  assert.equal(list.items[2]?.duplicateCount, 1);
  const other = await api.telesalesOrders(await login("agent2", "agent123"));
  const theirs = other.items[0]!.id;
  assert.equal(await code(api.telesalesOrder(t, theirs)), "NOT_FOUND");
  assert.equal(await code(api.confirmOrder(t, theirs)), "NOT_FOUND");
});

test("people without telesales.work are refused", async () => {
  assert.equal(await code(api.telesalesOrders(await login("keeper"))), "FORBIDDEN");
});

test("reschedule validates the time and moves the window; cancel needs a reason", async () => {
  const t = await login("agent", "agent123");
  const o = (await api.telesalesOrders(t)).items[1]!;
  assert.equal(await code(api.rescheduleOrder(t, o.id, new Date(Date.now() - 1000).toISOString())), "INVALID_TIME");
  assert.equal(await code(api.rescheduleOrder(t, o.id, inHours(24 * 9))), "INVALID_TIME");
  const r = await api.rescheduleOrder(t, o.id, inHours(30), "after work");
  assert.equal(r.callbackCount, 1);
  assert.ok(Date.parse(r.confirmBy!) > Date.parse(inHours(30)));
  assert.equal(await code(api.cancelTelesalesOrder(t, o.id, "no")), "BAD_REQUEST");
  const c = await api.cancelTelesalesOrder(t, o.id, "Customer changed their mind");
  assert.equal(c.status, "cancelled");
  assert.equal(await code(api.confirmOrder(t, o.id)), "NOT_AWAITING");
});

test("a duplicate-phone order cannot be confirmed until a manager approves; the manager may confirm directly", async () => {
  const t = await login("agent", "agent123");
  const dup = (await api.telesalesOrders(t)).items.find((o) => o.number === "UT-1043")!;
  const d = await api.telesalesOrder(t, dup.id);
  assert.equal(d.duplicates[0]?.number, "UT-1030");
  assert.equal(d.mayOverrideDuplicates, false);
  try { await api.confirmOrder(t, dup.id); assert.fail("should refuse"); } catch (e) {
    assert.ok(isApiError(e) && e.code === "DUPLICATE_PHONE");
    assert.equal((e.details as { duplicates: unknown[] }).duplicates.length, 1);
  }
  const a = await api.requestDuplicateApproval(t, dup.id, "second pair");
  assert.equal(a?.status, "pending");
  assert.equal((await api.requestDuplicateApproval(t, dup.id))?.id, a?.id); // idempotent
  assert.equal(await code(api.confirmOrder(t, dup.id)), "DUPLICATE_PHONE"); // pending is not approval
  await new Promise((r) => setTimeout(r, 8100)); // the mock manager answers after ~8 seconds
  assert.equal((await api.telesalesOrder(t, dup.id)).duplicateApproval?.status, "approved");
  assert.equal((await api.confirmOrder(t, dup.id)).confirmed, true);
});

test("an order with no duplicate needs no approval; confirming removes it from my list", async () => {
  const t = await login("agent", "agent123");
  const first = (await api.telesalesOrders(t)).items[0]!;
  assert.equal(await code(api.requestDuplicateApproval(t, first.id)), "NO_DUPLICATE");
  await api.confirmOrder(t, first.id);
  assert.ok(!(await api.telesalesOrders(t)).items.some((o) => o.id === first.id));
});

test("leads: agents see their own, status machine and follow-up rules, convert refuses a busy phone", async () => {
  const t = await login("agent", "agent123");
  const list = await api.leads(t, {});
  assert.ok(list.items.every((l) => l.assignedTo?.name === "Njoki"));
  assert.equal(list.total, 6);
  const mgr = await login("manager");
  assert.equal((await api.leads(mgr, {})).total, 8);
  assert.equal((await api.leads(t, { status: "rescheduled" })).total, 2);
  const theirs = (await api.leads(mgr, { q: "Hassan" })).items[0]!;
  assert.equal(await code(api.lead(t, theirs.id)), "NOT_FOUND");

  const fresh = (await api.leads(t, { q: "Beatrice" })).items[0]!;
  assert.equal(await code(api.updateLead(t, fresh.id, { status: "rescheduled", followUpDate: followUpIn(2) })), "CONFLICT"); // must be contacted first
  assert.equal((await api.updateLead(t, fresh.id, { status: "contacted" })).status, "contacted");
  assert.equal(await code(api.updateLead(t, fresh.id, { status: "rescheduled" })), "BAD_REQUEST");
  const r = await api.updateLead(t, fresh.id, { status: "rescheduled", followUpDate: followUpIn(2) });
  assert.equal(r.followUpDate, followUpIn(2));
  assert.equal(await code(api.updateLead(t, fresh.id, { status: "converted" })), "USE_CONVERT");
  const d = await api.addLeadActivity(t, fresh.id, "call", "No answer");
  assert.equal(d.activities[0]?.content, "No answer");
  assert.equal(await code(api.addLeadActivity(t, fresh.id, "call", "  ")), "BAD_REQUEST");

  const conv = await api.convertLead(t, fresh.id, { items: [{ productId: 1, quantity: 2 }] });
  assert.equal(conv.lead.status, "converted");
  assert.equal(conv.merged, false);
  assert.equal(await code(api.convertLead(t, fresh.id, {})), "CONFLICT");
});

test("convert onto a phone with an active order is refused with the order to merge into; merging works", async () => {
  const t = await login("agent", "agent123");
  const mercy = (await api.leads(t, { q: "Mercy A." })).items[0]!;
  try { await api.convertLead(t, mercy.id, {}); assert.fail("should refuse"); } catch (e) {
    assert.ok(isApiError(e) && e.code === "CONFLICT");
    assert.ok(typeof (e.details as { existingOrderId: number }).existingOrderId === "number");
  }
  let id = 0;
  try { await api.convertLead(t, mercy.id, {}); } catch (e) { id = (e as { details: { existingOrderId: number } }).details.existingOrderId; }
  const merged = await api.convertLead(t, mercy.id, { mergeIntoOrderId: id });
  assert.equal(merged.merged, true);
  assert.equal(merged.lead.status, "converted");
});

test("returns: receive, rules for the decision, never decided twice", async () => {
  const staff = await login("agent", "agent123");
  const found = await api.findReturnable(staff, "Grace");
  assert.equal(found.length, 1);
  assert.equal(await code(api.findReturnable(staff, "g").then((r) => (r.length ? Promise.reject(new Error("x")) : r))), "ok");
  const rec = await api.receiveReturn(staff, { orderId: found[0]!.id, reasonCode: "rejected", condition: "good", note: "refused at door" });
  assert.equal(rec.status, "returned_awaiting_inspection");
  assert.equal(await code(api.receiveReturn(staff, { orderId: found[0]!.id, reasonCode: "rejected", condition: "good" })), "NOT_RETURNABLE");
  assert.equal(await code(api.decideReturn(staff, rec.id, "restock")), "FORBIDDEN");

  const mgr = await login("manager");
  assert.equal(await code(api.decideReturn(mgr, rec.id, "write_off")), "FORBIDDEN"); // owner only
  assert.equal((await api.decideReturn(mgr, rec.id, "restock")).decision, "restock");
  assert.equal(await code(api.decideReturn(mgr, rec.id, "restock")), "ALREADY_DECIDED");

  const owner = await login("owner");
  const other = (await api.findReturnable(staff, "Samuel"))[0]!;
  await api.receiveReturn(staff, { orderId: other.id, reasonCode: "damaged", condition: "damaged" });
  const wo = await api.decideReturn(owner, other.id, "write_off", "water damage");
  assert.equal(wo.decision, "write_off");
  assert.equal((await api.returns(owner, { status: "decided" })).items.length, 2);
  assert.equal((await api.returns(owner, { status: "awaiting" })).items.some((r) => r.id === other.id), false);
});

test("countdown uses the server clock, not the phone's", () => {
  const phoneNow = 1_000_000; // a phone whose clock is wrong
  const serverTime = new Date(5_000_000_000).toISOString();
  const confirmBy = new Date(5_000_000_000 + 45 * 60_000).toISOString();
  const c = countdown(confirmBy, serverTime, phoneNow, phoneNow + 60_000)!;
  assert.equal(c.minutes, 44);
  assert.equal(c.urgent, false);
  assert.equal(countdown(confirmBy, serverTime, phoneNow, phoneNow + 10 * 60_000)!.urgent, false);
  assert.equal(countdown(confirmBy, serverTime, phoneNow, phoneNow + 20 * 60_000)!.urgent, true);
    assert.equal(countdown(confirmBy, serverTime, phoneNow, phoneNow + 46 * 60_000)!.expired, true);
  assert.equal(countdown(null, serverTime, phoneNow), null);
  assert.equal(countdown(new Date(5_000_000_000 + 125 * 60_000).toISOString(), serverTime, phoneNow, phoneNow)!.label, "2 h 5 min left");
});

test("callback choices are in the future and follow-up dates are calendar days", () => {
  const now = new Date(2026, 10, 7, 23, 30);
  assert.ok(callbackChoices(now).every((c) => c.at.getTime() > now.getTime()));
  assert.equal(followUpIn(2, now), "2026-11-09");
  assert.equal(isDueToday("2026-11-07", now), true);
  assert.equal(isDueToday("2026-11-08", now), false);
  assert.equal(isDueToday(null, now), false);
});
