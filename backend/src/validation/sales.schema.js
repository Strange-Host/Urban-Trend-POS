const { z } = require('zod');

// Money fields are integer cents (see CHANGES.md's currency-unification
// entry) — .int() here isn't just a nicety, it's what keeps a stray
// decimal amount from a client bug turning into fractional cents in the DB.
const checkoutSchema = z.object({
  items: z.array(z.object({
    product_id: z.number().int().positive(),
    quantity: z.number().int().positive(),
    discount: z.number().int().nonnegative().optional(),
  })).min(1, 'Sale must contain at least one item.'),
  payments: z.array(z.object({
    method: z.enum(['cash', 'card', 'mobile_money']),
    amount: z.number().int().positive(),
    reference: z.string().trim().min(1).optional(),
  })).min(1, 'At least one payment is required.'),
  customerId: z.number().int().positive().nullish(),
  discountTotal: z.number().int().nonnegative().optional(),
  // Offline register support: a client-generated UUID making checkout
  // idempotent, so a sale queued while offline can be retried safely.
  // Optional — plain online checkouts never send one.
  clientSaleId: z.string().trim().min(8).max(64).optional(),
});

module.exports = { checkoutSchema };
