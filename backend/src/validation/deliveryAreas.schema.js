const { z } = require('zod');

const cents = z.number().int().min(0).safe();

const createAreaSchema = z.object({
  area_name: z.string().trim().min(1).max(120),
  fee: cents,                                   // cents
  courier_type: z.enum(['boda', 'g4s']).optional().nullable(),
  notes: z.string().trim().max(300).optional().nullable(),
});

const updateAreaSchema = z.object({
  area_name: z.string().trim().min(1).max(120).optional(),
  fee: cents.optional(),
  courier_type: z.enum(['boda', 'g4s']).optional().nullable(),
  notes: z.string().trim().max(300).optional().nullable(),
  is_active: z.boolean().optional(),
});

// Bulk rows come from a pasted/uploaded sheet, so fee is in KES (a number or "1,200") and is
// converted to cents by the service, which also reports row-by-row problems.
const importAreasSchema = z.object({
  rows: z.array(z.object({
    area_name: z.union([z.string(), z.number()]).optional(),
    area: z.union([z.string(), z.number()]).optional(),
    fee: z.union([z.string(), z.number()]).optional(),
    rate: z.union([z.string(), z.number()]).optional(),
    courier_type: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
  })).min(1).max(2000),
});

module.exports = { createAreaSchema, updateAreaSchema, importAreasSchema };
