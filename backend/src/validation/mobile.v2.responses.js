const { z } = require('zod');
const base = require('./mobile.responses');

// Response shapes for the v2 endpoints (telesales, leads, returns). Every object is loose, as everywhere in /api/v1.
const iso = z.string().describe('ISO-8601 UTC timestamp');
const cents = z.number().int().describe('Money in the smallest KES unit (cents)');
const customer = z.looseObject({ name: z.string(), phone: z.string().nullable(), city: z.string().nullable().optional() });

const TelesalesOrderSummary = z.looseObject({
  id: z.number().int(), number: z.string(), status: z.string(), paymentType: z.string(), customer,
  totalCents: cents, deliveryFeeCents: cents, createdAt: iso,
  confirmBy: iso.nullable().describe('When the confirmation window ends and the order auto-cancels'),
  callbackAt: iso.nullable(), callbackCount: z.number().int(), itemCount: z.number().int().optional(), duplicateCount: z.number().int().optional(),
});
const TelesalesOrders = z.looseObject({ items: z.array(TelesalesOrderSummary), nextCursor: z.string().nullable(), total: z.number().int(), serverTime: iso });
const DuplicateApproval = z.looseObject({ id: z.number().int(), status: z.enum(['pending', 'approved', 'rejected', 'cancelled']), requestedAt: iso, reviewNote: z.string().nullable() });
const TelesalesOrder = TelesalesOrderSummary.extend({
  subtotalCents: cents, discountCents: cents, notes: z.string().nullable(), confirmed: z.boolean(),
  customerRisk: z.looseObject({ flag: z.string(), prepayRequired: z.boolean() }),
  items: z.array(z.looseObject({ name: z.string(), sku: z.string(), quantity: z.number().int(), unitPriceCents: cents, discountCents: cents, lineTotalCents: cents })),
  history: z.array(z.looseObject({ status: z.string(), note: z.string().nullable(), at: iso, by: z.string().nullable() })),
  duplicates: z.array(z.looseObject({ orderId: z.number().int(), number: z.string(), status: z.string(), totalCents: cents, createdAt: iso })),
  duplicateApproval: DuplicateApproval.nullable(), mayOverrideDuplicates: z.boolean(), serverTime: iso,
});
const DuplicateApprovalResult = z.looseObject({ approval: DuplicateApproval.nullable() });

const Lead = z.looseObject({
  id: z.number().int(), name: z.string(), phone: z.string(), email: z.string().nullable(), source: z.string(),
  status: z.enum(['new', 'contacted', 'rescheduled', 'converted', 'cancelled']), followUpDate: z.string().nullable(), notes: z.string().nullable(),
  assignedTo: z.looseObject({ id: z.number().int(), name: z.string() }).nullable(),
  interestedProduct: z.looseObject({ id: z.number().int(), name: z.string().nullable() }).nullable(),
  convertedOrderId: z.number().int().nullable(), lastActivityAt: iso.nullable(), createdAt: iso,
});
const Leads = z.looseObject({ items: z.array(Lead), nextCursor: z.string().nullable(), total: z.number().int() });
const LeadDetail = Lead.extend({ activities: z.array(z.looseObject({ id: z.number().int(), type: z.string(), content: z.string().nullable(), by: z.string().nullable(), at: iso })) });
const LeadConverted = z.looseObject({ lead: LeadDetail, orderId: z.number().int(), orderNumber: z.string(), merged: z.boolean() });

const ReturnItem = z.looseObject({
  id: z.number().int().describe('The order id: a return is the order that came back'), number: z.string(), status: z.string(), customer: customer.omit({ city: true }),
  totalCents: cents, itemCount: z.number().int(), reasonCode: z.enum(['rejected', 'damaged', 'wrong_item']).nullable(),
  condition: z.enum(['good', 'damaged']).nullable(), receivedBy: z.string().nullable(), receivedAt: iso.nullable(),
  decision: z.enum(['restock', 'write_off', 'dispose']).nullable(), decidedAt: iso.nullable(), note: z.string().nullable(),
});
const Returns = z.looseObject({ items: z.array(ReturnItem), nextCursor: z.string().nullable() });
const ReceivableOrders = z.looseObject({ items: z.array(ReturnItem) });

module.exports = {
  ErrorResponse: base.ErrorResponse,
  TelesalesOrders, TelesalesOrder, DuplicateApprovalResult, Lead, Leads, LeadDetail, LeadConverted, ReturnItem, Returns, ReceivableOrders,
};
