const { z } = require('zod');

// Request shapes for the v2 mobile endpoints (telesales, leads, returns). Unknown keys are ignored, as everywhere in /api/v1.
const id = z.number().int().positive();
const text = (max) => z.string().trim().max(max);
const reason = z.string().trim().min(3).max(300);

const rescheduleOrder = z.object({ callbackAt: z.string().trim().min(8).max(40), note: text(300).optional() });
const cancelOrder = z.object({ reason });
const requestDuplicateApproval = z.object({ note: text(300).optional() });

const LEAD_STATUSES = ['new', 'contacted', 'rescheduled', 'converted', 'cancelled'];
const patchLead = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  followUpDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-20').optional(),
  notes: text(2000).optional(),
});
const leadActivity = z.object({ type: z.enum(['call', 'message', 'note']), content: text(1000).min(1) });
const convertLead = z.object({
  items: z.array(z.object({ productId: id, quantity: z.number().int().positive() })).min(1).optional(),
  city: text(100).min(1).optional(),
  paymentType: z.enum(['cod', 'prepaid', 'g4s_pickup_pay']).optional(),
  courierType: z.enum(['boda', 'g4s']).optional(),
  notes: text(500).min(1).optional(),
  mergeIntoOrderId: id.optional(),
});

const RETURN_REASONS = ['rejected', 'damaged', 'wrong_item'];
const receiveReturn = z.object({ orderId: id, reasonCode: z.enum(RETURN_REASONS), condition: z.enum(['good', 'damaged']), note: text(300).optional() });
const returnDecision = z.object({ decision: z.enum(['restock', 'write_off', 'dispose']), note: text(300).optional() });

module.exports = { rescheduleOrder, cancelOrder, requestDuplicateApproval, patchLead, leadActivity, convertLead, receiveReturn, returnDecision, LEAD_STATUSES, RETURN_REASONS };
