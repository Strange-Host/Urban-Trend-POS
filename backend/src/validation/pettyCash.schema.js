const { z } = require('zod');

const createTopupSchema = z.object({
  amount: z.number().int().positive(), // smallest KES subunit (cents)
  note: z.string().trim().min(1).nullish(),
  topup_date: z.string().trim().min(1).optional(), // defaults to today
});

module.exports = { createTopupSchema };
