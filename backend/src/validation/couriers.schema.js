const { z } = require('zod');

const createCourierSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(30).optional().nullable(),
  vehicle: z.string().trim().max(60).optional().nullable(),
  courier_type: z.enum(['boda', 'g4s']),
  notes: z.string().trim().max(500).optional().nullable(),
});

const updateCourierSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().max(30).optional().nullable(),
  vehicle: z.string().trim().max(60).optional().nullable(),
  courier_type: z.enum(['boda', 'g4s']).optional(),
  notes: z.string().trim().max(500).optional().nullable(),
  is_active: z.boolean().optional(),
});

module.exports = { createCourierSchema, updateCourierSchema };
