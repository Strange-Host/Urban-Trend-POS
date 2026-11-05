import type {
  ApiV11,
  AttendanceToday,
  BulkApplied,
  BulkBatch,
  BulkPreview,
  BulkReverted,
  CatalogSettings,
  Category,
  CourierBalance,
  CourierCollection,
  CourierRemittance,
  Page,
  PaymentMatched,
  PaymentSuggestion,
  PriceHistoryItem,
  Product,
  RemittanceCreated,
  StockTake,
  StockTakeDetail,
  StockTakeProduct,
  StockTakeSubmitted,
  UnmatchedPage,
} from "./typesV11";

type Call = <T>(base: string, method: string, path: string, opts?: { token?: string; body?: unknown }) => Promise<T>;

const qs = (params: Record<string, string | number | boolean | undefined | null>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** The real server's v1.1 endpoints (backend/src/routes/v1/index.js). Field names are passed through unchanged. */
export function createHttpV11(base: string, call: Call): ApiV11 {
  const get = <T,>(token: string, path: string) => call<T>(base, "GET", path, { token });
  const post = <T,>(token: string, path: string, body: unknown = {}) => call<T>(base, "POST", path, { token, body });
  const patch = <T,>(token: string, path: string, body: unknown) => call<T>(base, "PATCH", path, { token, body });

  return {
    catalogSettings: (t) => get<CatalogSettings>(t, "/catalog/settings"),
    products: (t, f) => get<Page<Product>>(t, `/products${qs({ q: f.q, categoryId: f.categoryId, active: f.active === false ? "0" : undefined, cursor: f.cursor })}`),
    product: (t, id) => get<Product>(t, `/products/${id}`),
    createProduct: (t, d) => post<Product>(t, "/products", d),
    updateProduct: (t, id, p) => patch<Product>(t, `/products/${id}`, p),
    priceHistory: (t, id, cursor) => get<Page<PriceHistoryItem>>(t, `/products/${id}/price-history${qs({ cursor })}`),

    categories: async (t, includeInactive) => (await get<{ items: Category[] }>(t, `/categories${qs({ includeInactive: includeInactive ? "1" : undefined })}`)).items,
    createCategory: (t, name, parentId) => post<Category>(t, "/categories", { name, parentId: parentId ?? undefined }),
    updateCategory: (t, id, p) => patch<Category>(t, `/categories/${id}`, p),
    reorderCategories: async (t, ids) => (await post<{ items: Category[] }>(t, "/categories/reorder", { ids })).items,

    bulkPreview: (t, c) => post<BulkPreview>(t, "/prices/bulk/preview", c),
    bulkApply: (t, c, reason, fingerprint) => post<BulkApplied>(t, "/prices/bulk/apply", { ...c, reason, fingerprint }),
    bulkBatches: (t, cursor) => get<Page<BulkBatch>>(t, `/prices/bulk/batches${qs({ cursor })}`),
    bulkRevert: (t, id, reason) => post<BulkReverted>(t, `/prices/bulk/${id}/revert`, { reason }),

    stockTakes: (t, f) => get<Page<StockTake>>(t, `/stock-takes${qs({ status: f.status, mine: f.mine ? "1" : undefined, cursor: f.cursor })}`),
    stockTake: (t, id) => get<StockTakeDetail>(t, `/stock-takes/${id}`),
    startStockTake: (t, scope, note) => post<StockTake>(t, "/stock-takes", { scope, note }),
    stockTakeProducts: async (t, id, q) => (await get<{ items: StockTakeProduct[] }>(t, `/stock-takes/${id}/products${qs({ barcode: q.barcode, q: q.q })}`)).items,
    saveStockTakeLines: (t, id, lines) => post<StockTakeDetail>(t, `/stock-takes/${id}/lines`, { lines }),
    submitStockTake: (t, id) => post<StockTakeSubmitted>(t, `/stock-takes/${id}/submit`),
    approveStockTake: (t, id, note) => post<StockTakeDetail>(t, `/stock-takes/${id}/approve`, { note }),
    rejectStockTake: (t, id, reason) => post<StockTakeDetail>(t, `/stock-takes/${id}/reject`, { reason }),

    unmatchedPayments: (t, cursor) => get<UnmatchedPage>(t, `/payments/unmatched${qs({ cursor })}`),
    paymentSuggestions: async (t, id, q) => (await get<{ items: PaymentSuggestion[] }>(t, `/payments/${id}/suggestions${qs({ q })}`)).items,
    matchPayment: (t, id, orderId) => post<PaymentMatched>(t, `/payments/${id}/match`, { orderId }),
    ignorePayment: async (t, id, reason) => {
      await post(t, `/payments/${id}/ignore`, { reason });
    },

    courierBalances: async (t) => (await get<{ items: CourierBalance[] }>(t, "/couriers/balances")).items,
    courierCollections: async (t, id) => (await get<{ items: CourierCollection[] }>(t, `/couriers/${id}/collections`)).items,
    courierRemittances: (t, id, cursor) => get<Page<CourierRemittance>>(t, `/couriers/${id}/remittances${qs({ cursor })}`),
    createRemittance: (t, id, req) => post<RemittanceCreated>(t, `/couriers/${id}/remittances`, req),

    attendanceToday: (t) => get<AttendanceToday>(t, "/attendance/me"),
    // The server needs an explicit confirmation: clocking in is a deliberate tap, and no location is read or sent.
    clockIn: (t) => post<AttendanceToday>(t, "/attendance/clock-in", { confirm: true }),
    clockOut: (t, req) => post<AttendanceToday>(t, "/attendance/clock-out", req),
  };
}
