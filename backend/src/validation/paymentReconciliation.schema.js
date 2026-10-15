const { z } = require('zod');

// The exact field names KCB/M-Pesa will actually send are unknown until
// there's real API access (see CHANGES.md) — this is a reasonable normalized
// shape for "a payment happened", which the webhook route maps whatever the
// real payload looks like into. Expect this schema to need a small tweak
// once a real payload is in hand, not a rewrite.
const webhookNotificationSchema = z.object({
  method: z.enum(['mobile_money', 'bank_transfer', 'cash']),
  amount: z.number().int().positive(), // integer cents
  external_reference: z.string().trim().min(1).optional(), // the M-Pesa/KCB transaction code
  narrative: z.string().trim().min(1).optional(), // account number / payment description — where the product code usually is
  payer_name: z.string().trim().min(1).optional(),
  store_id: z.number().int().positive(),
  raw_payload: z.unknown().optional(),
  // 'incoming' (default) = a customer payment, matched to an order.
  // 'outgoing' = money the business paid OUT (supplier, courier, till
  // withdrawal) — mirrored into `expenses` instead of matched to an order.
  direction: z.enum(['incoming', 'outgoing']).optional(),
});

const manualMatchSchema = z.object({
  order_id: z.number().int().positive(),
  method: z.enum(['cash', 'card', 'mobile_money', 'bank_transfer']).optional(),
  reference: z.string().trim().min(1).optional(),
});

const simulateMpesaSchema = z.object({
  amount: z.number().positive(), // KES, decimal — Safaricom's sandbox simulate endpoint takes shillings, not cents
  msisdn: z.string().trim().regex(/^2547\d{8}$/, 'msisdn must be a Safaricom sandbox test number in the form 2547XXXXXXXX'),
  billRefNumber: z.string().trim().min(1), // the product code you want this test payment to match against
});

const stkPushSchema = z.object({
  amount: z.number().positive(),
  phone: z.string().trim().regex(/^2547\d{8}$/, 'phone must be in the form 2547XXXXXXXX'),
  accountReference: z.string().trim().min(1), // the product code
  description: z.string().trim().max(100).optional(),
});

module.exports = { webhookNotificationSchema, manualMatchSchema, simulateMpesaSchema, stkPushSchema };
