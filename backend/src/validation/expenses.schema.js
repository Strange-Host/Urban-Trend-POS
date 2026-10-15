const { z } = require('zod');

const createExpenseSchema = z.object({
  category_id: z.number().int().positive(),
  amount: z.number().int().nonnegative(), // integer cents
  description: z.string().trim().min(1).nullish(),
  expense_date: z.string().trim().min(1),
  receipt_url: z.string().trim().min(1).nullish(),
});

// PATCH allows partial updates — whatever's omitted keeps its existing
// value (see expenses.controller.js's update()), so every field here is
// optional even though it's required on create.
const updateExpenseSchema = createExpenseSchema.partial();

module.exports = { createExpenseSchema, updateExpenseSchema };
