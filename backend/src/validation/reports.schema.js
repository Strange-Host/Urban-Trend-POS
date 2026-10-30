const { z } = require('zod');

// Monthly forecast for the P&L. Amounts are integer cents.
const forecastSchema = z.object({
  revenue_target: z.number().int().min(0).safe(),
  expense_budget: z.number().int().min(0).safe(),
  notes: z.string().trim().max(300).optional().nullable(),
});

module.exports = { forecastSchema };
