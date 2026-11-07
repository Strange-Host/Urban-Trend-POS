import { can } from "../../lib/permissions";
import { ApiError } from "../errors";
import type { ApiErrorCode, SessionUser } from "../types";
import type { Page } from "../typesV11";
import type {
  ApiV2,
  DuplicateApproval,
  Lead,
  LeadActivity,
  LeadDetail,
  LeadStatus,
  ReturnItem,
  TelesalesOrder,
} from "../typesV2";
import type { MockDeps } from "./mockApiV11";

// The v2 half of the mock: the same rules the real server enforces (an agent reaches only their own orders and leads, the
// duplicate-phone approval, the confirmation window, rescheduling, the lead status machine, the return decision rules), so
// every screen can be driven without a server. In the mock a manager's answer to a duplicate-phone request arrives about
// eight seconds after the agent asks (the real one comes from the approvals list).

const fail = (code: ApiErrorCode, message: string, status = 409, details?: unknown) => new ApiError(code, message, status, details);
const need = (u: SessionUser, perm: string) => {
  if (!can(u, perm)) throw new ApiError("FORBIDDEN", "You do not have permission for this", 403);
};
const mins = (n: number) => new Date(Date.now() + n * 60_000).toISOString();
const PAGE = 20;
const MAX_RESCHEDULE_DAYS = 7;
const WINDOW_MIN = 120;
const ACTIVE = ["awaiting_dispatch", "dispatched_unpaid", "dispatched_partial"];

function page<T>(rows: T[], cursor?: string): Page<T> {
  const start = cursor ? parseInt(cursor, 10) || 0 : 0;
  return { items: rows.slice(start, start + PAGE), nextCursor: start + PAGE < rows.length ? String(start + PAGE) : null };
}

// ---------------------------------------------------------------- orders
interface MOrder {
  id: number;
  number: string;
  status: string; // awaiting_dispatch | cancelled | dispatched_unpaid | returned_in_transit | returned_awaiting_inspection | returned_resellable | returned_damaged
  assignedTo: number;
  name: string;
  phone: string;
  city: string;
  items: { name: string; sku: string; quantity: number; unitPriceCents: number }[];
  deliveryFeeCents: number;
  createdAt: string;
  confirmBy: string | null;
  callbackAt: string | null;
  callbackCount: number;
  confirmed: boolean;
  notes: string | null;
  history: { status: string; note: string | null; at: string; by: string | null }[];
  approval: (DuplicateApproval & { decideAt: number }) | null;
  // returns
  reasonCode: ReturnItem["reasonCode"];
  condition: ReturnItem["condition"];
  receivedBy: string | null;
  receivedAt: string | null;
  decision: ReturnItem["decision"];
  decidedAt: string | null;
  decisionNote: string | null;
}

let nextOrder = 1060;
function order(o: Partial<MOrder> & Pick<MOrder, "number" | "name" | "phone" | "assignedTo">): MOrder {
  nextOrder += 1;
  return {
    id: nextOrder - 60 + 1000, status: "awaiting_dispatch", city: "Nairobi",
    items: [{ name: "Canvas sneakers", sku: "SN-100", quantity: 1, unitPriceCents: 250000 }], deliveryFeeCents: 30000,
    createdAt: mins(-120), confirmBy: mins(60), callbackAt: null, callbackCount: 0, confirmed: false, notes: null, history: [], approval: null,
    reasonCode: null, condition: null, receivedBy: null, receivedAt: null, decision: null, decidedAt: null, decisionNote: null,
    ...o,
  };
}

// agent = user id 4, agent2 = id 5
const orders: MOrder[] = [
  order({ number: "UT-1041", name: "Faith Njeri", phone: "0712 345 678", assignedTo: 4, createdAt: mins(-190), confirmBy: mins(35), items: [{ name: "Leather belt", sku: "BL-210", quantity: 2, unitPriceCents: 120000 }, { name: "Canvas sneakers", sku: "SN-100", quantity: 1, unitPriceCents: 250000 }] }),
  order({ number: "UT-1042", name: "Peter Otieno", phone: "0722 111 222", assignedTo: 4, city: "Kisumu", createdAt: mins(-150), confirmBy: mins(80), deliveryFeeCents: 45000 }),
  order({ number: "UT-1043", name: "Mercy Achieng", phone: "0733 987 654", assignedTo: 4, createdAt: mins(-60), confirmBy: mins(110) }),
  order({ number: "UT-1044", name: "Kevin Mwangi", phone: "0700 555 000", assignedTo: 5, createdAt: mins(-100), confirmBy: mins(70) }),
  // Mercy already has another active order (confirmed, with the other agent): the duplicate-phone warning
  order({ number: "UT-1030", name: "Mercy Achieng", phone: "0733 987 654", assignedTo: 5, confirmed: true, confirmBy: null, createdAt: mins(-1500) }),
  // parcels that left the shop and may come back
  order({ number: "UT-0990", name: "Grace Wambui", phone: "0744 100 200", assignedTo: 5, status: "dispatched_unpaid", confirmed: true, confirmBy: null, createdAt: mins(-3000) }),
  order({ number: "UT-0991", name: "Samuel Kiptoo", phone: "0755 300 400", assignedTo: 5, status: "dispatched_unpaid", confirmed: true, confirmBy: null, createdAt: mins(-3100), items: [{ name: "Running shoes", sku: "RS-300", quantity: 1, unitPriceCents: 450000 }] }),
  order({ number: "UT-0985", name: "Lucy Chebet", phone: "0766 500 600", assignedTo: 5, status: "returned_awaiting_inspection", confirmed: true, confirmBy: null, createdAt: mins(-4000), reasonCode: "rejected", condition: "good", receivedBy: "Brian", receivedAt: mins(-300) }),
];

const digits = (p: string) => p.replace(/\D/g, "").slice(-9);
const numberOf = (o: MOrder) => o.number;

function duplicatesOf(o: MOrder) {
  return orders
    .filter((x) => x.id !== o.id && ACTIVE.includes(x.status) && digits(x.phone) === digits(o.phone))
    .map((x) => ({ orderId: x.id, number: x.number, status: x.status, totalCents: total(x), createdAt: x.createdAt }));
}
const sub = (o: MOrder) => o.items.reduce((s, i) => s + i.quantity * i.unitPriceCents, 0);
const total = (o: MOrder) => sub(o) + o.deliveryFeeCents;

function settle(o: MOrder) {
  // the mock manager answers a pending duplicate request after a few seconds
  if (o.approval?.status === "pending" && Date.now() >= o.approval.decideAt) o.approval = { ...o.approval, status: "approved", reviewNote: null };
}
const publicApproval = (a: MOrder["approval"]): DuplicateApproval | null => (a ? { id: a.id, status: a.status, requestedAt: a.requestedAt, reviewNote: a.reviewNote } : null);

function summary(o: MOrder) {
  return {
    id: o.id, number: numberOf(o), status: o.status, paymentType: "cod",
    customer: { name: o.name, phone: o.phone, city: o.city }, totalCents: total(o), deliveryFeeCents: o.deliveryFeeCents,
    createdAt: o.createdAt, confirmBy: o.confirmBy, callbackAt: o.callbackAt, callbackCount: o.callbackCount,
    itemCount: o.items.reduce((s, i) => s + i.quantity, 0), duplicateCount: duplicatesOf(o).length,
  };
}
function detail(u: SessionUser, o: MOrder): TelesalesOrder {
  settle(o);
  const dups = duplicatesOf(o);
  return {
    ...summary(o), subtotalCents: sub(o), discountCents: 0, notes: o.notes, confirmed: o.confirmed,
    customerRisk: { flag: "none", prepayRequired: false },
    items: o.items.map((i) => ({ ...i, discountCents: 0, lineTotalCents: i.quantity * i.unitPriceCents })),
    history: [...o.history].reverse(), duplicates: dups, duplicateApproval: dups.length ? publicApproval(o.approval) : null,
    mayOverrideDuplicates: can(u, "orders.approve_duplicate"), serverTime: new Date().toISOString(),
  };
}
function own(u: SessionUser, id: number): MOrder {
  const o = orders.find((x) => x.id === id);
  // someone else's order is a plain 404, like the real server
  if (!o || (u.role !== "owner" && o.assignedTo !== u.id)) throw fail("NOT_FOUND", "Order not found.", 404);
  return o;
}
function waiting(o: MOrder) {
  if (o.status !== "awaiting_dispatch" || o.confirmed) throw fail("NOT_AWAITING", "This order is not waiting for a confirmation call any more.");
}
const sqlNow = () => Date.now();
let approvalSeq = 500;

// ---------------------------------------------------------------- leads
interface MLead extends Omit<LeadDetail, "activities"> {
  activities: LeadActivity[];
}
let leadSeq = 200;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const dayOf = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
function mkLead(l: Partial<MLead> & Pick<MLead, "name" | "phone" | "assignedTo">): MLead {
  leadSeq += 1;
  return { id: leadSeq, email: null, source: "whatsapp", status: "new", followUpDate: null, notes: null, interestedProduct: null, convertedOrderId: null, lastActivityAt: null, createdAt: ago(1), activities: [], ...l };
}
const agentRef = { id: 4, name: "Njoki" };
const agent2Ref = { id: 5, name: "Otieno" };
const leads: MLead[] = [
  mkLead({ name: "Beatrice Wanjala", phone: "0711 222 333", assignedTo: agentRef, interestedProduct: { id: 1, name: "Canvas sneakers" }, createdAt: ago(0) }),
  mkLead({ name: "Daniel Kariuki", phone: "0722 444 555", assignedTo: agentRef, status: "contacted", notes: "Wants two pairs, size 42", interestedProduct: { id: 2, name: "Leather belt" }, createdAt: ago(2),
    activities: [{ id: 1, type: "call", content: "Picked up, will confirm on Friday", by: "Njoki", at: ago(1) }] }),
  mkLead({ name: "Esther Muthoni", phone: "0733 666 777", assignedTo: agentRef, status: "rescheduled", followUpDate: dayOf(0), source: "referral", createdAt: ago(4) }),
  mkLead({ name: "Francis Omondi", phone: "0744 888 999", assignedTo: agentRef, status: "rescheduled", followUpDate: dayOf(3), createdAt: ago(5) }),
  mkLead({ name: "Gladys Naliaka", phone: "0755 121 212", assignedTo: agentRef, status: "converted", convertedOrderId: 1020, createdAt: ago(9) }),
  // Her number already has an active order (UT-1030): converting must offer to merge instead of creating a second one
  mkLead({ name: "Mercy A.", phone: "0733 987 654", assignedTo: agentRef, status: "contacted", interestedProduct: { id: 3, name: "Leather belt" }, createdAt: ago(1) }),
  mkLead({ name: "Hassan Ali", phone: "0766 343 434", assignedTo: agent2Ref, createdAt: ago(1) }),
  mkLead({ name: "Irene Jepchirchir", phone: "0777 565 656", assignedTo: agent2Ref, status: "contacted", createdAt: ago(3) }),
];
const TRANSITIONS: Record<LeadStatus, LeadStatus[]> = { new: ["contacted", "cancelled"], contacted: ["rescheduled", "converted", "cancelled"], rescheduled: ["contacted", "converted", "cancelled"], converted: [], cancelled: [] };
const leadView = (l: MLead): Lead => { const { activities: _a, ...rest } = l; void _a; return rest; };
const leadDetail = (l: MLead): LeadDetail => ({ ...leadView(l), activities: [...l.activities].sort((a, b) => b.at.localeCompare(a.at)) });
function ownLead(u: SessionUser, id: number): MLead {
  const l = leads.find((x) => x.id === id);
  if (!l || (u.role !== "owner" && !can(u, "orders.approve_duplicate") && l.assignedTo?.id !== u.id)) throw fail("NOT_FOUND", "Lead not found.", 404);
  return l;
}
const seeAll = (u: SessionUser) => u.role === "owner" || can(u, "orders.approve_duplicate"); // managers see every lead, agents their own
let activitySeq = 100;
function logActivity(l: MLead, u: SessionUser, type: string, content: string) {
  activitySeq += 1;
  const at = new Date().toISOString();
  l.activities.push({ id: activitySeq, type, content, by: u.name, at });
  l.lastActivityAt = at;
}

// ---------------------------------------------------------------- returns
const RECEIVABLE = ["dispatched_unpaid", "dispatched_partial", "dispatched_paid", "returned_in_transit"];
const awaitingStates = (o: MOrder) => o.status === "returned_awaiting_inspection" || (o.status === "returned_damaged" && !o.decision);
const decidedStates = (o: MOrder) => o.status === "returned_resellable" || (o.status === "returned_damaged" && !!o.decision);
function returnView(o: MOrder): ReturnItem {
  return {
    id: o.id, number: o.number, status: o.status, customer: { name: o.name, phone: o.phone }, totalCents: total(o), itemCount: o.items.reduce((s, i) => s + i.quantity, 0),
    reasonCode: o.reasonCode, condition: o.condition, receivedBy: o.receivedBy, receivedAt: o.receivedAt, decision: o.decision, decidedAt: o.decidedAt, note: o.decisionNote,
  };
}

export function createMockV2({ gate, userFor }: MockDeps): ApiV2 {
  const run = async <T,>(token: string, fn: (u: SessionUser) => T): Promise<T> => {
    await gate();
    return fn(userFor(token));
  };

  return {
    // ---------------------------------------------------------- telesales
    telesalesOrders: (t, cursor) =>
      run(t, (u) => {
        need(u, "telesales.work");
        const mine = orders
          .filter((o) => o.assignedTo === u.id && o.status === "awaiting_dispatch" && !o.confirmed)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const p = page(mine.map(summary), cursor);
        return { ...p, total: mine.length, serverTime: new Date().toISOString() };
      }),

    telesalesOrder: (t, id) => run(t, (u) => (need(u, "telesales.work"), detail(u, own(u, id)))),

    confirmOrder: (t, id) =>
      run(t, (u) => {
        need(u, "telesales.work");
        const o = own(u, id);
        waiting(o);
        settle(o);
        const dups = duplicatesOf(o);
        if (dups.length && !can(u, "orders.approve_duplicate") && o.approval?.status !== "approved") {
          throw fail("DUPLICATE_PHONE", "This phone number already has another active order. A manager has to approve confirming this one.", 409, { duplicates: dups, approval: publicApproval(o.approval) });
        }
        if (o.confirmBy && Date.parse(o.confirmBy) < sqlNow()) {
          throw fail("CONFLICT", "The confirmation window for this order has already elapsed, so it will be cancelled.");
        }
        o.confirmed = true;
        o.callbackAt = null;
        o.history.push({ status: o.status, note: "COD confirmation recorded.", at: new Date().toISOString(), by: u.name });
        return detail(u, o);
      }),

    rescheduleOrder: (t, id, callbackAt, note) =>
      run(t, (u) => {
        need(u, "telesales.work");
        const o = own(u, id);
        waiting(o);
        const when = Date.parse(callbackAt);
        if (Number.isNaN(when) || when <= Date.now()) throw fail("INVALID_TIME", "Pick a time in the future to call back.", 400);
        if (when > Date.now() + MAX_RESCHEDULE_DAYS * 86_400_000) throw fail("INVALID_TIME", `You can reschedule up to ${MAX_RESCHEDULE_DAYS} days ahead.`, 400);
        o.callbackAt = new Date(when).toISOString();
        o.callbackCount += 1;
        const newExpiry = new Date(when + WINDOW_MIN * 60_000).toISOString();
        if (!o.confirmBy || o.confirmBy < newExpiry) o.confirmBy = newExpiry; // the window restarts from the callback time
        o.history.push({ status: o.status, note: `Call rescheduled to ${o.callbackAt}${note ? `: ${note}` : ""}`, at: new Date().toISOString(), by: u.name });
        return detail(u, o);
      }),

    cancelTelesalesOrder: (t, id, reason) =>
      run(t, (u) => {
        need(u, "telesales.work");
        const o = own(u, id);
        waiting(o);
        if (reason.trim().length < 3) throw fail("BAD_REQUEST", "reason: Too small: expected string to have >=3 characters", 400);
        o.status = "cancelled";
        o.history.push({ status: "cancelled", note: `Cancelled by telesales: ${reason.trim()}`, at: new Date().toISOString(), by: u.name });
        if (o.approval && (o.approval.status === "pending" || o.approval.status === "approved")) o.approval = { ...o.approval, status: "cancelled" };
        return detail(u, o);
      }),

    requestDuplicateApproval: (t, id, note) =>
      run(t, (u) => {
        need(u, "telesales.work");
        const o = own(u, id);
        waiting(o);
        if (!duplicatesOf(o).length) throw fail("NO_DUPLICATE", "This order has no duplicate phone number, so it needs no approval.");
        settle(o);
        if (o.approval && (o.approval.status === "pending" || o.approval.status === "approved")) return publicApproval(o.approval);
        approvalSeq += 1;
        void note;
        o.approval = { id: approvalSeq, status: "pending", requestedAt: new Date().toISOString(), reviewNote: null, decideAt: Date.now() + 8000 };
        return publicApproval(o.approval);
      }),

    // ---------------------------------------------------------- leads
    leads: (t, f) =>
      run(t, (u) => {
        need(u, "leads.work");
        const q = f.q?.trim().toLowerCase();
        const rows = leads
          .filter((l) => seeAll(u) || l.assignedTo?.id === u.id)
          .filter((l) => (f.status ? l.status === f.status : true))
          .filter((l) => (q ? l.name.toLowerCase().includes(q) || l.phone.includes(q) : true))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return { ...page(rows.map(leadView), f.cursor), total: rows.length };
      }),

    lead: (t, id) => run(t, (u) => (need(u, "leads.work"), leadDetail(ownLead(u, id)))),

    updateLead: (t, id, p) =>
      run(t, (u) => {
        need(u, "leads.work");
        const l = ownLead(u, id);
        if (p.status === undefined && p.notes === undefined) throw fail("BAD_REQUEST", "Nothing to change.", 400);
        if (p.status === "converted") throw fail("USE_CONVERT", "Use Convert to order to turn a lead into an order.", 400);
        if (p.status !== undefined && p.status !== l.status) {
          if (!TRANSITIONS[l.status].includes(p.status)) {
            throw fail("CONFLICT", `Cannot move a lead from "${l.status}" to "${p.status}". Valid next states: ${TRANSITIONS[l.status].join(", ") || "none — this status is terminal"}.`);
          }
          if (p.status === "rescheduled" && !p.followUpDate) throw fail("BAD_REQUEST", "follow_up_date is required when moving a lead to rescheduled.", 400);
          logActivity(l, u, "status_change", `Status changed from ${l.status} to ${p.status}`);
          l.status = p.status;
          l.followUpDate = p.status === "rescheduled" ? (p.followUpDate as string) : null;
        }
        if (p.notes !== undefined) l.notes = p.notes;
        return leadDetail(l);
      }),

    addLeadActivity: (t, id, type, content) =>
      run(t, (u) => {
        need(u, "leads.work");
        const l = ownLead(u, id);
        if (!content.trim()) throw fail("BAD_REQUEST", "content: Too small", 400);
        logActivity(l, u, type, content.trim());
        return leadDetail(l);
      }),

    convertLead: (t, id, req) =>
      run(t, (u) => {
        need(u, "leads.work");
        const l = ownLead(u, id);
        if (l.status === "converted") throw fail("CONFLICT", "This lead has already been converted.", 409, { orderId: l.convertedOrderId });
        if (l.status === "cancelled") throw fail("CONFLICT", "This lead is cancelled and cannot be converted.");
        if (!req.items?.length && !l.interestedProduct) throw fail("BAD_REQUEST", "Add at least one item - this lead has no product of interest to start from.", 400);
        const existing = orders.find((o) => ACTIVE.includes(o.status) && digits(o.phone) === digits(l.phone));
        const items = req.items?.length
          ? req.items.map((i) => ({ name: `Product ${i.productId}`, sku: `P-${i.productId}`, quantity: i.quantity, unitPriceCents: 150000 }))
          : [{ name: l.interestedProduct?.name ?? "Item", sku: "SKU", quantity: 1, unitPriceCents: 150000 }];
        if (existing && req.mergeIntoOrderId !== existing.id) {
          throw fail("CONFLICT", "This phone number already has an active order. Merge the items into it, or fix the number.", 409, { existingOrderId: existing.id, canMerge: existing.status === "awaiting_dispatch" });
        }
        let target: MOrder;
        let merged = false;
        if (existing) {
          existing.items.push(...items);
          target = existing;
          merged = true;
        } else {
          target = order({ number: `UT-${1100 + orders.length}`, name: l.name, phone: l.phone, assignedTo: l.assignedTo?.id ?? u.id, items, city: req.city ?? "Nairobi", confirmBy: mins(WINDOW_MIN), createdAt: new Date().toISOString() });
          orders.push(target);
        }
        l.status = "converted";
        l.followUpDate = null;
        l.convertedOrderId = target.id;
        logActivity(l, u, "status_change", `Converted to order ${target.number}`);
        return { lead: leadDetail(l), orderId: target.id, orderNumber: target.number, merged };
      }),

    // ---------------------------------------------------------- returns
    returns: (t, f) =>
      run(t, (u) => {
        need(u, "returns.receive");
        const rows = orders.filter((o) => (f.status === "decided" ? decidedStates(o) : awaitingStates(o))).sort((a, b) => b.id - a.id);
        return page(rows.map(returnView), f.cursor);
      }),

    findReturnable: (t, q) =>
      run(t, (u) => {
        need(u, "returns.receive");
        const needle = q.trim().toLowerCase();
        if (needle.length < 2) return [];
        return orders
          .filter((o) => RECEIVABLE.includes(o.status))
          .filter((o) => o.number.toLowerCase().includes(needle) || o.name.toLowerCase().includes(needle) || o.phone.replace(/\s/g, "").includes(needle.replace(/\s/g, "")))
          .slice(0, 20)
          .map(returnView);
      }),

    receiveReturn: (t, req) =>
      run(t, (u) => {
        need(u, "returns.receive");
        const o = orders.find((x) => x.id === req.orderId);
        if (!o) throw fail("NOT_FOUND", "Order not found.", 404);
        if (!RECEIVABLE.includes(o.status)) throw fail("NOT_RETURNABLE", `This order is "${o.status.replace(/_/g, " ")}", so there is no parcel to receive.`);
        o.status = "returned_awaiting_inspection";
        o.reasonCode = req.reasonCode;
        o.condition = req.condition;
        o.receivedBy = u.name;
        o.receivedAt = new Date().toISOString();
        o.decisionNote = req.note ?? null;
        return returnView(o);
      }),

    decideReturn: (t, id, decision, note) =>
      run(t, (u) => {
        const o = orders.find((x) => x.id === id);
        if (!o) throw fail("NOT_FOUND", "Order not found.", 404);
        if (decision === "restock") need(u, "orders.inspect");
        else if (u.role !== "owner") throw new ApiError("FORBIDDEN", "Only the owner can write off or dispose of returned stock.", 403);
        if (decidedStates(o)) throw fail("ALREADY_DECIDED", "This return was already decided.");
        if (o.status === "returned_damaged" && decision === "restock") throw fail("NOT_RESTOCKABLE", "This parcel was inspected as damaged and cannot go back on sale.");
        if (!awaitingStates(o)) throw fail("NOT_RECEIVED", "This parcel has not been received yet.");
        if (decision === "restock") o.status = "returned_resellable";
        else {
          o.status = "returned_damaged";
          o.decision = decision;
        }
        if (decision === "restock") o.decision = "restock";
        o.decidedAt = new Date().toISOString();
        o.decisionNote = note ?? o.decisionNote;
        return returnView(o);
      }),
  };
}
