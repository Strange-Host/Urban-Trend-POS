const { z } = require('zod');
const { MAX_CENTS } = require('./products.schema');

// Request shapes for the v1.1 mobile endpoints (catalog, categories, bulk prices, stock-takes, payments, couriers,
// attendance). Like the rest of /api/v1, unknown keys are ignored so a newer app never breaks an older server.

const cents = z.number().int().min(0).max(MAX_CENTS);
const id = z.number().int().positive();
const reason = z.string().trim().min(3).max(300);
const text = (max) => z.string().trim().max(max);

// ---- catalog
const createProduct = z.object({
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().min(1).max(64),
  barcode: z.string().trim().max(64).nullish(),
  categoryId: id.nullish(),
  sellPriceCents: cents,
  costPriceCents: cents.optional(),
  isActive: z.boolean().optional(),
});

const patchProduct = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  sku: z.string().trim().min(1).max(64).optional(),
  barcode: z.string().trim().max(64).nullable().optional(),
  categoryId: id.nullable().optional(),
  sellPriceCents: z.number().int().min(-1).max(MAX_CENTS).optional(), // <= 0 is answered with INVALID_PRICE, not a vague 400
  costPriceCents: cents.optional(),
  isActive: z.boolean().optional(),
  reason: text(300).optional(),
});

// ---- categories
const createCategory = z.object({ name: z.string().trim().min(1).max(100), parentId: id.nullish() });
const patchCategory = z.object({ name: z.string().trim().min(1).max(100).optional(), isActive: z.boolean().optional() });
const reorderCategories = z.object({ ids: z.array(id).min(1).max(500) });

// ---- bulk prices
const bulkChange = z.object({
  categoryId: id,
  mode: z.enum(['percent', 'fixed']),
  value: z.number().finite().min(-1_000_000_000).max(1_000_000_000),
  includeInactive: z.boolean().optional(),
});
const bulkApply = bulkChange.extend({ reason, fingerprint: z.string().min(8).max(128) });
const bulkRevert = z.object({ reason: text(300).optional() });

module.exports = { createProduct, patchProduct, createCategory, patchCategory, reorderCategories, bulkChange, bulkApply, bulkRevert, cents, id, reason, text };

// ---- stock-takes
const startStockTake = z.object({
  scope: z.object({ type: z.enum(['all', 'category']), categoryId: id.nullish() }),
  note: text(300).optional(),
});
const stockTakeLines = z.object({
  lines: z.array(z.object({ productId: id, countedQty: z.number().int().min(0).max(1_000_000) })).min(1).max(500),
});
const approveStockTake = z.object({ note: text(300).optional() });
const rejectStockTake = z.object({ reason });
Object.assign(module.exports, { startStockTake, stockTakeLines, approveStockTake, rejectStockTake });

// ---- payments, couriers, attendance
const matchPayment = z.object({
  orderId: id,
  method: z.enum(['cash', 'card', 'mobile_money', 'bank_transfer']).optional(),
  reference: text(100).optional(),
});
const ignorePayment = z.object({ reason });
const createRemittance = z.object({
  collectionIds: z.array(id).min(1).max(200),
  remittedCents: cents,
  chargeEnteredCents: cents.optional(),
  reference: text(100).optional(),
  note: text(300).optional(),
});
const clockIn = z.object({ confirm: z.boolean().optional() });
const clockOut = z.object({
  confirmAllDispatched: z.boolean().optional(),
  confirmNairobiReconciled: z.boolean().optional(),
  handoverNotes: text(1000).optional(),
});
Object.assign(module.exports, { matchPayment, ignorePayment, createRemittance, clockIn, clockOut });
