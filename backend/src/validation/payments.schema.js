const { z } = require('zod');

const createPaymentSchema = z.object({
  direction: z.enum(['incoming', 'outgoing']),
  sale_id: z.number().int().positive().nullish(),
  supplier_name: z.string().trim().min(1).nullish(),
  method: z.enum(['cash', 'card', 'mobile_money', 'bank_transfer']),
  amount: z.number().int().positive(), // integer cents
  reference: z.string().trim().min(1).nullish(),
  notes: z.string().trim().min(1).nullish(),
})
  .refine((data) => data.direction !== 'incoming' || !!data.sale_id, {
    message: 'sale_id is required for incoming payments.',
    path: ['sale_id'],
  })
  .refine((data) => data.direction !== 'outgoing' || !!data.supplier_name, {
    message: 'supplier_name is required for outgoing payments.',
    path: ['supplier_name'],
  });

module.exports = { createPaymentSchema };
