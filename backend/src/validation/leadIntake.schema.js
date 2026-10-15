const { z } = require('zod');

const createRouteSchema = z.object({
  form_name: z.string().trim().min(1).max(200),
  product_id: z.number().int().positive().nullable().optional(),
  assigned_staff_id: z.number().int().positive().nullable().optional(),
});

const updateRouteSchema = z.object({
  form_name: z.string().trim().min(1).max(200).optional(),
  product_id: z.number().int().positive().nullable().optional(),
  assigned_staff_id: z.number().int().positive().nullable().optional(),
  is_active: z.boolean().optional(),
});

module.exports = { createRouteSchema, updateRouteSchema };
