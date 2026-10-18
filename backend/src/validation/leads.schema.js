const { z } = require('zod');

// POST /api/leads/:id/convert. Everything is optional: the name, phone, email and
// assigned rep come from the lead itself, and with no items the order starts with
// one unit of the product the lead asked about.
const convertLeadSchema = z.object({
  items: z.array(z.object({
    product_id: z.number().int().positive(),
    quantity: z.number().int().positive(),
    discount: z.number().int().nonnegative().optional(),
  })).min(1).optional(),
  city: z.string().trim().min(1).optional(),
  discount_total: z.number().int().nonnegative().optional(),
  notes: z.string().trim().min(1).optional(),
  payment_type: z.enum(['cod', 'prepaid', 'g4s_pickup_pay']).optional(),
  courier_type: z.enum(['boda', 'g4s']).optional(),
  // The one-click merge: set to the id of the customer's existing active order
  // (returned in the 409 details) to add these items to it instead of failing.
  merge_into_order_id: z.number().int().positive().optional(),
});

module.exports = { convertLeadSchema };
