const { z } = require('zod');

const itemSchema = z.object({
  product_id: z.number().int().positive(),
  quantity: z.number().int().positive(),
  discount: z.number().int().nonnegative().optional(),
});

const createOrderSchema = z.object({
  name: z.string().trim().min(1).optional(), // optional if the phone already matches an existing customer
  phone: z.string().trim().min(1, 'phone is required.'),
  email: z.string().trim().email().optional(),
  city: z.string().trim().min(1).optional(),
  lead_id: z.number().int().positive().nullish(),
  assigned_staff_id: z.number().int().positive().nullish(),
  channel: z.enum(['shopify', 'wordpress', 'manual']).optional(),
  items: z.array(itemSchema).min(1, 'Order must contain at least one item.'),
  discount_total: z.number().int().nonnegative().optional(),
  notes: z.string().trim().min(1).optional(),
  payment_type: z.enum(['cod', 'prepaid', 'g4s_pickup_pay']).optional(),
  courier_type: z.enum(['boda', 'g4s']).optional(),
});

const setCourierSchema = z.object({
  courier_type: z.enum(['boda', 'g4s']).optional(),
  courier_id: z.number().int().positive().nullable().optional(),
});

const mergeItemsSchema = z.object({
  items: z.array(itemSchema).min(1, 'At least one item is required to merge.'),
});

const recordPaymentSchema = z.object({
  method: z.enum(['cash', 'card', 'mobile_money', 'bank_transfer']),
  amount: z.number().int().positive(), // integer cents
  reference: z.string().trim().min(1).optional(),
});

const inspectReturnSchema = z.object({
  result: z.enum(['good', 'damaged']),
  notes: z.string().trim().min(1).optional(),
});

const notesOnlySchema = z.object({
  notes: z.string().trim().min(1).optional(),
});

const returnedInTransitSchema = z.object({
  notes: z.string().trim().min(1).optional(),
  reason_code: z.enum(['rejected', 'damaged', 'wrong_item']).optional(),
});

const ownerDecisionSchema = z.object({
  decision: z.enum(['write_off', 'dispose']),
  notes: z.string().trim().min(1).optional(),
});

const openDisputeSchema = z.object({
  reason: z.string().trim().min(1, 'reason is required.'),
});

const resolveDisputeSchema = z.object({
  outcome: z.enum(['refund', 'redelivered', 'closed']),
  notes: z.string().trim().min(1).optional(),
});

module.exports = {
  createOrderSchema, mergeItemsSchema, setCourierSchema, recordPaymentSchema, inspectReturnSchema,
  notesOnlySchema, returnedInTransitSchema, ownerDecisionSchema, openDisputeSchema, resolveDisputeSchema,
};
