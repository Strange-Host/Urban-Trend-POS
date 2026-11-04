const { z } = require('zod');
const base = require('./mobile.responses');

// Response shapes for the v1.1 endpoints. As everywhere in /api/v1 every object is loose (the server may add fields);
// what is pinned here can never disappear or change type without the contract tests failing.

const iso = z.string().describe('ISO-8601 UTC timestamp');
const cents = z.number().int().describe('Money in the smallest KES unit (cents)');
const list = (item, extra = {}) => z.looseObject({ items: z.array(item), nextCursor: z.string().nullable(), ...extra });

const Product = z.looseObject({
  id: z.number().int(), sku: z.string(), barcode: z.string().nullable(), name: z.string(),
  categoryId: z.number().int().nullable(), categoryName: z.string().nullable(),
  sellPriceCents: cents,
  costPriceCents: cents.optional().describe('ABSENT (not null) unless the caller holds products.view_cost'),
  marginCents: cents.optional().describe('ABSENT unless the caller holds products.view_cost'),
  isActive: z.boolean(), catalogue: z.enum(['shop', 'online']), approvalStatus: z.string(), updatedAt: z.string(),
});
const ProductList = list(Product);

const PriceHistoryItem = z.looseObject({
  id: z.number().int(), oldPriceCents: cents, newPriceCents: cents, reason: z.string().nullable(),
  source: z.enum(['edit', 'bulk', 'bulk_revert', 'online_sync', 'web']), batchId: z.number().int().nullable(),
  changedBy: z.looseObject({ id: z.number().int().nullable(), name: z.string() }), changedAt: iso,
});
const PriceHistory = list(PriceHistoryItem);

const CatalogSettings = z.looseObject({ priceMaster: z.enum(['pos', 'online']), pricePushOnline: z.boolean(), pushImplemented: z.boolean() });

const Category = z.looseObject({
  id: z.number().int(), name: z.string(), parentId: z.number().int().nullable(), isActive: z.boolean(),
  sortOrder: z.number().int(), productCount: z.number().int(),
});
const CategoryList = z.looseObject({ items: z.array(Category) });

const BulkPreview = z.looseObject({
  fingerprint: z.string(), count: z.number().int(), skippedCount: z.number().int(),
  items: z.array(z.looseObject({ productId: z.number().int(), name: z.string(), sku: z.string(), oldPriceCents: cents, newPriceCents: cents, deltaCents: cents })),
  skipped: z.array(z.looseObject({ productId: z.number().int(), name: z.string(), reason: z.string() })),
});
const BulkApplied = z.looseObject({ batchId: z.number().int(), count: z.number().int(), appliedAt: iso });
const BulkBatch = z.looseObject({
  id: z.number().int(), kind: z.enum(['bulk', 'bulk_revert']), categoryId: z.number().int().nullable(), categoryName: z.string().nullable(),
  mode: z.string(), value: z.number(), reason: z.string().nullable(), productCount: z.number().int(),
  createdBy: z.looseObject({ id: z.number().int().nullable(), name: z.string() }), createdAt: iso,
  revertedAt: iso.nullable(), revertsBatchId: z.number().int().nullable(),
});
const BulkBatches = list(BulkBatch);
const BulkReverted = z.looseObject({
  batchId: z.number().int(), count: z.number().int(),
  skipped: z.array(z.looseObject({ productId: z.number().int(), name: z.string(), reason: z.string() })),
});

module.exports = {
  ...base, list, iso, cents,
  Product, ProductList, PriceHistory, CatalogSettings, Category, CategoryList, BulkPreview, BulkApplied, BulkBatches, BulkReverted,
};
