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

// ---- stock-takes
const StockTake = z.looseObject({
  id: z.number().int(),
  scope: z.looseObject({ type: z.enum(['all', 'category']), categoryId: z.number().int().nullable(), categoryName: z.string().nullable() }),
  status: z.enum(['draft', 'applied', 'pending_approval', 'rejected']), note: z.string().nullable(),
  createdBy: z.looseObject({ id: z.number().int(), name: z.string() }), createdAt: iso, submittedAt: iso.nullable(),
  lineCount: z.number().int(), varianceUnits: z.number().int(), needsApprovalCount: z.number().int(),
});
const StockTakeLine = z.looseObject({
  productId: z.number().int(), name: z.string(), sku: z.string(), barcode: z.string().nullable(),
  countedQty: z.number().int(), systemQty: z.number().int(), variance: z.number().int(), needsApproval: z.boolean(), applied: z.boolean(),
});
const StockTakeDetail = StockTake.extend({ lines: z.array(StockTakeLine) });
const StockTakeList = list(StockTake);
const StockTakeSubmitted = z.looseObject({
  status: z.enum(['applied', 'pending_approval']),
  applied: z.array(z.looseObject({ productId: z.number().int(), variance: z.number().int() })),
  pendingApproval: z.array(z.looseObject({ productId: z.number().int(), variance: z.number().int() })),
  notCountedCount: z.number().int(),
});
Object.assign(module.exports, { StockTake, StockTakeLine, StockTakeDetail, StockTakeList, StockTakeSubmitted });

// ---- payments
const UnmatchedPayment = z.looseObject({
  id: z.number().int(), source: z.string(), method: z.string(), amountCents: cents, payerName: z.string().nullable(),
  reference: z.string().nullable(), createdAt: iso, ageMinutes: z.number().int(),
});
const UnmatchedPayments = list(UnmatchedPayment, { total: z.number().int(), unallocatedCents: cents });
const PaymentSuggestions = z.looseObject({
  items: z.array(z.looseObject({
    orderId: z.number().int(), number: z.string(), customerName: z.string(), customerPhone: z.string().nullable(),
    totalCents: cents, balanceCents: cents, status: z.string(), score: z.number(), reasons: z.array(z.enum(['code', 'amount', 'phone', 'name'])),
  })),
});
const PaymentMatched = z.looseObject({
  payment: z.looseObject({ id: z.number().int(), status: z.literal('matched') }),
  order: z.looseObject({ id: z.number().int(), number: z.string(), paymentState: z.enum(['paid', 'partial']), balanceCents: cents }),
});
const PaymentIgnored = z.looseObject({ payment: z.looseObject({ id: z.number().int(), status: z.literal('ignored') }) });

// ---- couriers
const CourierBalances = z.looseObject({
  items: z.array(z.looseObject({
    courierId: z.number().int(), name: z.string(), kind: z.string(), outstandingCents: cents, overdueCents: cents, paused: z.boolean(),
    openCollections: z.number().int(), oldestCollectionOn: z.string().nullable(),
    buckets: z.array(z.looseObject({ label: z.string(), cents })),
  })),
});
const CourierCollections = z.looseObject({
  items: z.array(z.looseObject({ collectionId: z.number().int(), orderId: z.number().int(), orderNumber: z.string(), customerName: z.string(), amountCents: cents, feeCents: cents, collectedOn: z.string() })),
});
const CourierRemittances = list(z.looseObject({
  id: z.number().int(), createdAt: iso, createdBy: z.looseObject({ id: z.number().int(), name: z.string() }),
  collectionsCents: cents, feesCents: cents, remittedCents: cents, cashVarianceCents: cents, reference: z.string().nullable(),
}));
const RemittanceCreated = z.looseObject({ id: z.number().int(), remittedCents: cents, expectedCents: cents, cashVarianceCents: cents, settledCount: z.number().int() });

// ---- attendance
const AttendanceToday = z.looseObject({
  workDate: z.string(), status: z.enum(['not_started', 'clocked_in', 'clocked_out']), clockInAt: iso.nullable(), clockOutAt: iso.nullable(),
  gate: z.looseObject({
    mode: z.string(), blocked: z.boolean(), reasonRequired: z.boolean(), canConfirmDispatched: z.boolean(), canConfirmNairobi: z.boolean(),
    undispatchedOrders: z.number().int(), nairobiUnpaid: z.number().int(), custodyOpen: z.number().int(), unmatchedPayments: z.number().int(),
  }).nullable(),
});
Object.assign(module.exports, { UnmatchedPayments, PaymentSuggestions, PaymentMatched, PaymentIgnored, CourierBalances, CourierCollections, CourierRemittances, RemittanceCreated, AttendanceToday });

const StockTakeProducts = z.looseObject({ items: z.array(z.looseObject({ productId: z.number().int(), name: z.string(), sku: z.string(), barcode: z.string().nullable(), systemQty: z.number().int() })) });
Object.assign(module.exports, { StockTakeProducts });
