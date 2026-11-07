// Contract for the v2 endpoints (telesales orders, leads, returns). Field names are read from the server's response schemas
// (backend/src/validation/mobile.v2.responses.js). Money is integer cents; timestamps are ISO-8601 UTC.

import type { Page } from "./typesV11";

// ---- telesales
export interface TelesalesCustomer {
  name: string;
  phone: string | null;
  city: string | null;
}
export interface TelesalesOrderSummary {
  id: number;
  number: string;
  status: string;
  paymentType: string;
  customer: TelesalesCustomer;
  totalCents: number;
  deliveryFeeCents: number;
  createdAt: string;
  /** End of the confirmation window: the order auto-cancels after this. */
  confirmBy: string | null;
  callbackAt: string | null;
  callbackCount: number;
  itemCount?: number;
  duplicateCount?: number;
}
export interface TelesalesPage extends Page<TelesalesOrderSummary> {
  total: number;
  /** The server's clock, so the countdown does not depend on the phone's. */
  serverTime: string;
}
export type DuplicateApprovalStatus = "pending" | "approved" | "rejected" | "cancelled";
export interface DuplicateApproval {
  id: number;
  status: DuplicateApprovalStatus;
  requestedAt: string;
  reviewNote: string | null;
}
export interface DuplicateOrder {
  orderId: number;
  number: string;
  status: string;
  totalCents: number;
  createdAt: string;
}
export interface TelesalesOrder extends TelesalesOrderSummary {
  subtotalCents: number;
  discountCents: number;
  notes: string | null;
  confirmed: boolean;
  customerRisk: { flag: string; prepayRequired: boolean };
  items: { name: string; sku: string; quantity: number; unitPriceCents: number; discountCents: number; lineTotalCents: number }[];
  history: { status: string; note: string | null; at: string; by: string | null }[];
  duplicates: DuplicateOrder[];
  duplicateApproval: DuplicateApproval | null;
  /** True for a person who may confirm a duplicate without asking (they hold orders.approve_duplicate). */
  mayOverrideDuplicates: boolean;
  /** The server's clock when this was read, for the countdown. */
  serverTime: string;
}

// ---- leads
export type LeadStatus = "new" | "contacted" | "rescheduled" | "converted" | "cancelled";
export interface Lead {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  source: string;
  status: LeadStatus;
  followUpDate: string | null; // YYYY-MM-DD
  notes: string | null;
  assignedTo: { id: number; name: string } | null;
  interestedProduct: { id: number; name: string | null } | null;
  convertedOrderId: number | null;
  lastActivityAt: string | null;
  createdAt: string;
}
export interface LeadActivity {
  id: number;
  type: string; // call | message | meeting | note | status_change
  content: string | null;
  by: string | null;
  at: string;
}
export interface LeadDetail extends Lead {
  activities: LeadActivity[];
}
export interface LeadsPage extends Page<Lead> {
  total: number;
}
export interface LeadPatch {
  status?: LeadStatus;
  followUpDate?: string;
  notes?: string;
}
export interface LeadConvertRequest {
  items?: { productId: number; quantity: number }[];
  city?: string;
  paymentType?: "cod" | "prepaid" | "g4s_pickup_pay";
  notes?: string;
  mergeIntoOrderId?: number;
}
export interface LeadConverted {
  lead: LeadDetail;
  orderId: number;
  orderNumber: string;
  merged: boolean;
}

// ---- returns
export type ReturnReason = "rejected" | "damaged" | "wrong_item";
export type ReturnCondition = "good" | "damaged";
export type ReturnDecisionKind = "restock" | "write_off" | "dispose";
export interface ReturnItem {
  /** The order id: a return is the order that came back. */
  id: number;
  number: string;
  status: string;
  customer: { name: string; phone: string | null };
  totalCents: number;
  itemCount: number;
  reasonCode: ReturnReason | null;
  condition: ReturnCondition | null;
  receivedBy: string | null;
  receivedAt: string | null;
  decision: ReturnDecisionKind | null;
  decidedAt: string | null;
  note: string | null;
}

export type ApiErrorCodeV2 =
  | "CONFLICT"
  | "DUPLICATE_PHONE"
  | "NOT_AWAITING"
  | "NO_DUPLICATE"
  | "INVALID_TIME"
  | "USE_CONVERT"
  | "ALREADY_RESCHEDULED"
  | "NOT_RETURNABLE"
  | "NOT_RECEIVED"
  | "ALREADY_DECIDED"
  | "NOT_RESTOCKABLE"
  | "BAD_REQUEST";

export const V2_ERROR_CODES: ApiErrorCodeV2[] = [
  "CONFLICT", "DUPLICATE_PHONE", "NOT_AWAITING", "NO_DUPLICATE", "INVALID_TIME", "USE_CONVERT", "ALREADY_RESCHEDULED",
  "NOT_RETURNABLE", "NOT_RECEIVED", "ALREADY_DECIDED", "NOT_RESTOCKABLE", "BAD_REQUEST",
];

/** The v2 half of the Api the app depends on. Mock and HTTP both implement it. */
export interface ApiV2 {
  telesalesOrders(accessToken: string, cursor?: string): Promise<TelesalesPage>;
  telesalesOrder(accessToken: string, id: number): Promise<TelesalesOrder>;
  confirmOrder(accessToken: string, id: number): Promise<TelesalesOrder>;
  rescheduleOrder(accessToken: string, id: number, callbackAt: string, note?: string): Promise<TelesalesOrder>;
  cancelTelesalesOrder(accessToken: string, id: number, reason: string): Promise<TelesalesOrder>;
  requestDuplicateApproval(accessToken: string, id: number, note?: string): Promise<DuplicateApproval | null>;

  leads(accessToken: string, f: { status?: LeadStatus; q?: string; cursor?: string }): Promise<LeadsPage>;
  lead(accessToken: string, id: number): Promise<LeadDetail>;
  updateLead(accessToken: string, id: number, patch: LeadPatch): Promise<LeadDetail>;
  addLeadActivity(accessToken: string, id: number, type: "call" | "message" | "note", content: string): Promise<LeadDetail>;
  convertLead(accessToken: string, id: number, req: LeadConvertRequest): Promise<LeadConverted>;

  returns(accessToken: string, f: { status?: "awaiting" | "decided"; cursor?: string }): Promise<Page<ReturnItem>>;
  findReturnable(accessToken: string, q: string): Promise<ReturnItem[]>;
  receiveReturn(accessToken: string, req: { orderId: number; reasonCode: ReturnReason; condition: ReturnCondition; note?: string }): Promise<ReturnItem>;
  decideReturn(accessToken: string, id: number, decision: ReturnDecisionKind, note?: string): Promise<ReturnItem>;
}
