const { z } = require('zod');

const cents = z.number().int().positive();
const method = z.enum(['cash', 'mobile_money', 'bank_transfer']);
const costPaidVia = z.enum(['cash', 'mobile_money', 'bank_transfer', 'deducted_by_courier']);
const reason = z.string().trim().min(1, 'A reason is required.').max(500);

const feeReceiptSchema = z.object({
  amount: cents,
  method,
  reference: z.string().trim().max(100).optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
});

const recordDeliveryCostSchema = z.object({
  kind: z.enum(['outpost_leg', 'onward_transport', 'handling', 'storage', 'fuel', 'return_trip', 'packaging', 'other']),
  amount: cents,
  reason,
  paid_via: costPaidVia,
  reference: z.string().trim().max(100).optional().nullable(),
});

const reverseDeliveryCostSchema = z.object({ amount: cents, reason });
const rejectDeliveryCostSchema = z.object({ reason });
const closeSettlementSchema = z.object({
  note: z.string().trim().max(500).optional().nullable(),
  write_off_reason: z.string().trim().max(500).optional().nullable(),
});
const adjustmentSchema = z.object({
  target_type: z.enum(['package_fee', 'courier_cost']),
  cost_id: z.number().int().positive().optional(),     // the courier cost being corrected (target_type courier_cost)
  delta: z.number().int().refine((n) => n !== 0, 'delta cannot be 0'),
  reason,
});
const verifyReceiptSchema = z.object({ note: reason });
const reopenSettlementSchema = z.object({ reason });

module.exports = {
  feeReceiptSchema, recordDeliveryCostSchema, reverseDeliveryCostSchema, rejectDeliveryCostSchema,
  closeSettlementSchema, reopenSettlementSchema, adjustmentSchema, verifyReceiptSchema,
};
