// Contract for the v1.1 endpoints (catalog, categories, bulk prices, stock-take, payment matching, courier remittance,
// attendance). Field names are read from the server's response schemas (backend/src/validation/mobile.v11.responses.js).
// Money is integer cents. costPriceCents / marginCents are ABSENT (not null) unless the server allowed this person to see cost.

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// ---- catalog
export interface Product {
  id: number;
  sku: string;
  barcode: string | null;
  name: string;
  categoryId: number | null;
  categoryName: string | null;
  sellPriceCents: number;
  costPriceCents?: number;
  marginCents?: number;
  isActive: boolean;
  catalogue: "shop" | "online";
  approvalStatus: string;
  updatedAt: string;
}

export interface ProductFilter {
  q?: string;
  categoryId?: number;
  active?: boolean; // default true
  cursor?: string;
}

export interface ProductDraft {
  name: string;
  sku: string;
  barcode?: string | null;
  categoryId?: number | null;
  sellPriceCents: number;
  costPriceCents?: number;
  isActive?: boolean;
}

export interface ProductPatch extends Partial<ProductDraft> {
  /** Required by the server whenever sellPriceCents changes. */
  reason?: string;
}

export type PriceSource = "edit" | "bulk" | "bulk_revert" | "online_sync" | "web";
export interface PriceHistoryItem {
  id: number;
  oldPriceCents: number;
  newPriceCents: number;
  reason: string | null;
  source: PriceSource;
  batchId: number | null;
  changedBy: { id: number | null; name: string };
  changedAt: string;
}

export interface CatalogSettings {
  priceMaster: "pos" | "online";
  pricePushOnline: boolean;
  pushImplemented: boolean;
}

export interface Category {
  id: number;
  name: string;
  parentId: number | null;
  isActive: boolean;
  sortOrder: number;
  productCount: number;
}

// ---- bulk price change
export type BulkMode = "percent" | "fixed";
export interface BulkChange {
  categoryId: number;
  mode: BulkMode;
  value: number; // percent (e.g. -7.5) or signed cents
  includeInactive?: boolean;
}
export interface BulkPreviewItem {
  productId: number;
  name: string;
  sku: string;
  oldPriceCents: number;
  newPriceCents: number;
  deltaCents: number;
}
export interface BulkSkipped {
  productId: number;
  name: string;
  reason: string; // PRICE_NOT_POSITIVE | UNCHANGED | PRICE_CHANGED_SINCE
}
export interface BulkPreview {
  fingerprint: string;
  count: number;
  skippedCount: number;
  items: BulkPreviewItem[];
  skipped: BulkSkipped[];
}
export interface BulkApplied {
  batchId: number;
  count: number;
  appliedAt: string;
}
export interface BulkBatch {
  id: number;
  kind: "bulk" | "bulk_revert";
  categoryId: number | null;
  categoryName: string | null;
  mode: string;
  value: number;
  reason: string | null;
  productCount: number;
  createdBy: { id: number | null; name: string };
  createdAt: string;
  revertedAt: string | null;
  revertsBatchId: number | null;
}
export interface BulkReverted {
  batchId: number;
  count: number;
  skipped: BulkSkipped[];
}

// ---- stock-take
export type StockTakeStatus = "draft" | "applied" | "pending_approval" | "rejected";
export interface StockTakeScope {
  type: "all" | "category";
  categoryId?: number | null;
}
export interface StockTake {
  id: number;
  scope: { type: "all" | "category"; categoryId: number | null; categoryName: string | null };
  status: StockTakeStatus;
  note: string | null;
  createdBy: { id: number; name: string };
  createdAt: string;
  submittedAt: string | null;
  lineCount: number;
  varianceUnits: number;
  needsApprovalCount: number;
  reviewNote?: string;
}
export interface StockTakeLine {
  productId: number;
  name: string;
  sku: string;
  barcode: string | null;
  countedQty: number;
  systemQty: number; // live while a draft, frozen at submit
  variance: number;
  needsApproval: boolean;
  applied: boolean;
}
export interface StockTakeDetail extends StockTake {
  lines: StockTakeLine[];
}
export interface StockTakeProduct {
  productId: number;
  name: string;
  sku: string;
  barcode: string | null;
  systemQty: number;
}
export interface StockTakeSubmitted {
  status: "applied" | "pending_approval";
  applied: { productId: number; variance: number }[];
  pendingApproval: { productId: number; variance: number }[];
  notCountedCount: number;
}

// ---- unmatched payments
export interface UnmatchedPayment {
  id: number;
  source: string;
  method: string;
  amountCents: number;
  payerName: string | null;
  reference: string | null;
  createdAt: string;
  ageMinutes: number;
}
export interface UnmatchedPage extends Page<UnmatchedPayment> {
  total: number;
  unallocatedCents: number;
}
export type SuggestionReason = "code" | "amount" | "phone" | "name";
export interface PaymentSuggestion {
  orderId: number;
  number: string;
  customerName: string;
  customerPhone: string | null;
  totalCents: number;
  balanceCents: number;
  status: string;
  score: number;
  reasons: SuggestionReason[];
}
export interface PaymentMatched {
  payment: { id: number; status: "matched" };
  order: { id: number; number: string; paymentState: "paid" | "partial"; balanceCents: number };
}

// ---- courier remittance
export interface CourierBalance {
  courierId: number;
  name: string;
  kind: string;
  outstandingCents: number;
  overdueCents: number;
  paused: boolean;
  openCollections: number;
  oldestCollectionOn: string | null;
  buckets: { label: string; cents: number }[];
}
export interface CourierCollection {
  collectionId: number;
  orderId: number;
  orderNumber: string;
  customerName: string;
  amountCents: number;
  feeCents: number; // package fee we owe for this parcel, netted off the cash
  collectedOn: string;
}
export interface CourierRemittance {
  id: number;
  createdAt: string;
  createdBy: { id: number; name: string };
  collectionsCents: number;
  feesCents: number;
  remittedCents: number;
  cashVarianceCents: number;
  reference: string | null;
}
export interface RemittanceRequest {
  collectionIds: number[];
  remittedCents: number;
  reference?: string;
  note?: string;
}
export interface RemittanceCreated {
  id: number;
  remittedCents: number;
  expectedCents: number;
  cashVarianceCents: number;
  settledCount: number;
}

// ---- attendance
export interface AttendanceToday {
  workDate: string;
  status: "not_started" | "clocked_in" | "clocked_out";
  clockInAt: string | null;
  clockOutAt: string | null;
  gate: {
    mode: string;
    blocked: boolean;
    reasonRequired: boolean;
    canConfirmDispatched: boolean;
    canConfirmNairobi: boolean;
    undispatchedOrders: number;
    nairobiUnpaid: number;
    custodyOpen: number;
    unmatchedPayments: number;
  } | null;
}
export interface ClockOutRequest {
  confirmAllDispatched?: boolean;
  confirmNairobiReconciled?: boolean;
  handoverNotes?: string;
}

/** Stable error codes the v1.1 screens branch on (the server sends these in error.code). */
export type ApiErrorCodeV11 =
  | "NOT_FOUND"
  | "DUPLICATE_SKU"
  | "DUPLICATE_BARCODE"
  | "DUPLICATE_NAME"
  | "REASON_REQUIRED"
  | "INVALID_PRICE"
  | "INVALID_CATEGORY"
  | "INVALID_ORDER"
  | "PREVIEW_STALE"
  | "TOO_MANY"
  | "NOTHING_TO_CHANGE"
  | "ALREADY_REVERTED"
  | "NOT_REVERTIBLE"
  | "NOTHING_TO_REVERT"
  | "NOT_DRAFT"
  | "NOT_PENDING"
  | "NO_LINES"
  | "NOT_IN_SCOPE"
  | "SELF_APPROVAL"
  | "ALREADY_MATCHED"
  | "ALREADY_IGNORED"
  | "ORDER_NOT_FOUND"
  | "ORDER_NOT_PAYABLE"
  | "AMOUNT_EXCEEDS_BALANCE"
  | "ALREADY_SETTLED"
  | "STATEMENT_EXCEEDS_COLLECTIONS"
  | "STATEMENT_NOTHING_SETTLED"
  | "STATEMENT_WRONG_ORGANIZATION"
  | "CONFIRM_REQUIRED"
  | "ALREADY_CLOCKED_IN"
  | "NOT_CLOCKED_IN"
  | "ALREADY_CLOCKED_OUT"
  | "CLOCKOUT_CONFIRMATION_REQUIRED"
  | "CLOCKOUT_CONFIRMATION_FALSE"
  | "CLOCKOUT_REASON_REQUIRED"
  | "CLOCKOUT_BLOCKED"
  | "MODULE_DISABLED";

export const V11_ERROR_CODES: ApiErrorCodeV11[] = [
  "NOT_FOUND", "DUPLICATE_SKU", "DUPLICATE_BARCODE", "DUPLICATE_NAME", "REASON_REQUIRED", "INVALID_PRICE", "INVALID_CATEGORY",
  "INVALID_ORDER", "PREVIEW_STALE", "TOO_MANY", "NOTHING_TO_CHANGE", "ALREADY_REVERTED", "NOT_REVERTIBLE", "NOTHING_TO_REVERT",
  "NOT_DRAFT", "NOT_PENDING", "NO_LINES", "NOT_IN_SCOPE", "SELF_APPROVAL", "ALREADY_MATCHED", "ALREADY_IGNORED", "ORDER_NOT_FOUND",
  "ORDER_NOT_PAYABLE", "AMOUNT_EXCEEDS_BALANCE", "ALREADY_SETTLED", "STATEMENT_EXCEEDS_COLLECTIONS", "STATEMENT_NOTHING_SETTLED",
  "STATEMENT_WRONG_ORGANIZATION", "CONFIRM_REQUIRED", "ALREADY_CLOCKED_IN", "NOT_CLOCKED_IN", "ALREADY_CLOCKED_OUT",
  "CLOCKOUT_CONFIRMATION_REQUIRED", "CLOCKOUT_CONFIRMATION_FALSE", "CLOCKOUT_REASON_REQUIRED", "CLOCKOUT_BLOCKED", "MODULE_DISABLED",
];

/** The v1.1 half of the Api the app depends on. Mock and HTTP both implement it. */
export interface ApiV11 {
  catalogSettings(accessToken: string): Promise<CatalogSettings>;
  products(accessToken: string, f: ProductFilter): Promise<Page<Product>>;
  product(accessToken: string, id: number): Promise<Product>;
  createProduct(accessToken: string, draft: ProductDraft): Promise<Product>;
  updateProduct(accessToken: string, id: number, patch: ProductPatch): Promise<Product>;
  priceHistory(accessToken: string, productId: number, cursor?: string): Promise<Page<PriceHistoryItem>>;

  categories(accessToken: string, includeInactive?: boolean): Promise<Category[]>;
  createCategory(accessToken: string, name: string, parentId?: number | null): Promise<Category>;
  updateCategory(accessToken: string, id: number, patch: { name?: string; isActive?: boolean }): Promise<Category>;
  reorderCategories(accessToken: string, ids: number[]): Promise<Category[]>;

  bulkPreview(accessToken: string, change: BulkChange): Promise<BulkPreview>;
  bulkApply(accessToken: string, change: BulkChange, reason: string, fingerprint: string): Promise<BulkApplied>;
  bulkBatches(accessToken: string, cursor?: string): Promise<Page<BulkBatch>>;
  bulkRevert(accessToken: string, batchId: number, reason?: string): Promise<BulkReverted>;

  stockTakes(accessToken: string, f: { status?: StockTakeStatus; mine?: boolean; cursor?: string }): Promise<Page<StockTake>>;
  stockTake(accessToken: string, id: number): Promise<StockTakeDetail>;
  startStockTake(accessToken: string, scope: StockTakeScope, note?: string): Promise<StockTake>;
  stockTakeProducts(accessToken: string, id: number, q: { barcode?: string; q?: string }): Promise<StockTakeProduct[]>;
  saveStockTakeLines(accessToken: string, id: number, lines: { productId: number; countedQty: number }[]): Promise<StockTakeDetail>;
  submitStockTake(accessToken: string, id: number): Promise<StockTakeSubmitted>;
  approveStockTake(accessToken: string, id: number, note?: string): Promise<StockTakeDetail>;
  rejectStockTake(accessToken: string, id: number, reason: string): Promise<StockTakeDetail>;

  unmatchedPayments(accessToken: string, cursor?: string): Promise<UnmatchedPage>;
  paymentSuggestions(accessToken: string, id: number, q?: string): Promise<PaymentSuggestion[]>;
  matchPayment(accessToken: string, id: number, orderId: number): Promise<PaymentMatched>;
  ignorePayment(accessToken: string, id: number, reason: string): Promise<void>;

  courierBalances(accessToken: string): Promise<CourierBalance[]>;
  courierCollections(accessToken: string, courierId: number): Promise<CourierCollection[]>;
  courierRemittances(accessToken: string, courierId: number, cursor?: string): Promise<Page<CourierRemittance>>;
  createRemittance(accessToken: string, courierId: number, req: RemittanceRequest): Promise<RemittanceCreated>;

  attendanceToday(accessToken: string): Promise<AttendanceToday>;
  clockIn(accessToken: string): Promise<AttendanceToday>;
  clockOut(accessToken: string, req: ClockOutRequest): Promise<AttendanceToday>;
}
