const { z } = require('zod');

const cents = z.number().int().positive();

const recordCostSchema = z.object({
  kind: z.enum(['return_trip', 'fuel', 'airtime', 'handling', 'repair', 'other']),
  amount: cents,
  description: z.string().trim().min(1).max(300),
  order_id: z.number().int().positive().optional().nullable(),
  receipt_ref: z.string().trim().max(100).optional().nullable(),
});

const rejectCostSchema = z.object({ reason: z.string().trim().min(1).max(300) });

const payoutSchema = z.object({
  method: z.enum(['mpesa', 'bank', 'cash']),
  payment_ref: z.string().trim().max(100).optional().nullable(),
  // Omit to pay everything unpaid; or list the exact items to settle.
  items: z.array(z.object({ type: z.enum(['package_fee', 'courier_cost']), id: z.number().int().positive() })).min(1).optional(),
});

module.exports = { recordCostSchema, rejectCostSchema, payoutSchema };
