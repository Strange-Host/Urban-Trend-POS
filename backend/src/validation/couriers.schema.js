const { z } = require('zod');

const createCourierSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(30).optional().nullable(),
  vehicle: z.string().trim().max(60).optional().nullable(),
  courier_type: z.enum(['boda', 'g4s']).optional(), // an organization defaults to 'g4s'; a rider must give one
  notes: z.string().trim().max(500).optional().nullable(),
  // Courier organizations. kind is fixed at creation.
  kind: z.enum(['rider', 'organization']).optional(),
  collects_payment: z.boolean().optional(),
  contact_person: z.string().trim().max(100).optional().nullable(),
  overdue_limit: z.number().int().min(0).optional().nullable(),       // cents
  overdue_after_days: z.number().int().min(1).max(365).optional(),
});

const updateCourierSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().max(30).optional().nullable(),
  vehicle: z.string().trim().max(60).optional().nullable(),
  courier_type: z.enum(['boda', 'g4s']).optional(),
  notes: z.string().trim().max(500).optional().nullable(),
  is_active: z.boolean().optional(),
  collects_payment: z.boolean().optional(),
  contact_person: z.string().trim().max(100).optional().nullable(),
  overdue_limit: z.number().int().min(0).optional().nullable(),
  overdue_after_days: z.number().int().min(1).max(365).optional(),
});

const cents = z.number().int().safe();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date format YYYY-MM-DD.');

const recordCollectionSchema = z.object({
  order_id: z.number().int().positive(),
  amount: cents,
  collected_on: isoDate.optional(),
});

const createStatementSchema = z.object({
  period_start: isoDate,
  period_end: isoDate,
  collection_ids: z.array(z.number().int().positive()).min(1),
  charge_entered: cents,
  remitted: cents,
  remittance_ref: z.string().trim().max(100).optional().nullable(),
});

module.exports = { createCourierSchema, updateCourierSchema, recordCollectionSchema, createStatementSchema };
