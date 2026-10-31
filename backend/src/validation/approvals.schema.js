const { z } = require('zod');

// A request names exactly what it is about: a sale to void, or a recorded payment to refund.
const createApprovalSchema = z.object({
  kind: z.enum(['void_sale', 'refund_payment']),
  sale_id: z.number().int().positive().optional(),
  payment_id: z.number().int().positive().optional(),
  reason: z.string().trim().min(3, 'Say why this is needed (a few words is enough).').max(300),
})
  .refine((d) => d.kind !== 'void_sale' || !!d.sale_id, { message: 'sale_id is required to ask for a void.', path: ['sale_id'] })
  .refine((d) => d.kind !== 'refund_payment' || !!d.payment_id, { message: 'payment_id is required to ask for a refund.', path: ['payment_id'] });

const rejectApprovalSchema = z.object({
  note: z.string().trim().min(3, 'Say why you are rejecting it, so the person who asked knows.').max(300),
});

module.exports = { createApprovalSchema, rejectApprovalSchema };
