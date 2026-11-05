import { planBulk } from "../../lib/bulkPrice";
import { can } from "../../lib/permissions";
import { ApiError } from "../errors";
import type { ApiErrorCode, SessionUser } from "../types";
import type {
  ApiV11,
  AttendanceToday,
  BulkBatch,
  BulkChange,
  Category,
  CourierCollection,
  CourierRemittance,
  Page,
  PriceHistoryItem,
  Product,
  StockTake,
  StockTakeDetail,
  StockTakeLine,
  StockTakeScope,
  UnmatchedPayment,
} from "../typesV11";

// The v1.1 half of the mock: the same rules the real server enforces (reason required, duplicate SKU, stale bulk preview,
// revert as a new batch, one match per payment, no double settlement, the clock-out gate), so every screen can be driven
// without a server. Money is integer cents.

export interface MockDeps {
  gate: () => Promise<void>;
  /** Resolves the access token to a signed-in user (throws TOKEN_EXPIRED / DEVICE_REVOKED like the real API). */
  userFor: (token: string) => SessionUser;
}

const fail = (code: ApiErrorCode, message: string, status = 409) => new ApiError(code, message, status);
const minsAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const APPROVAL_LIMIT_UNITS = 10;
const PAGE = 20;

// ---------------------------------------------------------------- data
interface MProduct {
  id: number;
  sku: string;
  barcode: string | null;
  name: string;
  categoryId: number | null;
  sell: number;
  cost: number;
  active: boolean;
  stock: number;
}
let cats: Category[] = [
  { id: 1, name: "Shirts", parentId: null, isActive: true, sortOrder: 0, productCount: 0 },
  { id: 2, name: "Jackets", parentId: null, isActive: true, sortOrder: 1, productCount: 0 },
  { id: 3, name: "Accessories", parentId: null, isActive: true, sortOrder: 2, productCount: 0 },
  { id: 4, name: "Old stock", parentId: null, isActive: false, sortOrder: 3, productCount: 0 },
];
let nextCat = 5;
const products: MProduct[] = [
  { id: 1, sku: "LIN-SH-L", barcode: "6161100010011", name: "Linen shirt L", categoryId: 1, sell: 320_000, cost: 190_000, active: true, stock: 14 },
  { id: 2, sku: "LIN-SH-M", barcode: "6161100010101", name: "Linen shirt M", categoryId: 1, sell: 320_000, cost: 190_000, active: true, stock: 22 },
  { id: 3, sku: "OXF-SH-L", barcode: "6161100010202", name: "Oxford shirt L", categoryId: 1, sell: 280_000, cost: 160_000, active: true, stock: 9 },
  { id: 4, sku: "DEN-JK-M", barcode: "6161100010028", name: "Denim jacket M", categoryId: 2, sell: 780_000, cost: 450_000, active: true, stock: 4 },
  { id: 5, sku: "BOM-JK-L", barcode: "6161100010303", name: "Bomber jacket L", categoryId: 2, sell: 950_000, cost: 600_000, active: true, stock: 6 },
  { id: 6, sku: "CAN-BLT", barcode: "6161100010035", name: "Canvas belt", categoryId: 3, sell: 120_000, cost: 50_000, active: true, stock: 31 },
  { id: 7, sku: "CAP-BLK", barcode: "6161100010042", name: "Cap black", categoryId: 3, sell: 30_000, cost: 12_000, active: true, stock: 2 },
  { id: 8, sku: "SCF-RED", barcode: null, name: "Red scarf", categoryId: 3, sell: 45_000, cost: 20_000, active: false, stock: 0 },
];
let nextProduct = 9;
const history: (PriceHistoryItem & { productId: number })[] = [
  { id: 1, productId: 1, oldPriceCents: 300_000, newPriceCents: 320_000, reason: "Supplier increase", source: "edit", batchId: null, changedBy: { id: 1, name: "Jon" }, changedAt: minsAgo(60 * 24 * 12) },
];
let nextHistory = 2;
const batches: BulkBatch[] = [];
let nextBatch = 1;

// ---------------------------------------------------------------- helpers
const costVisible = (u: SessionUser) => can(u, "products.view_cost");
function present(u: SessionUser, p: MProduct): Product {
  const base: Product = {
    id: p.id, sku: p.sku, barcode: p.barcode, name: p.name, categoryId: p.categoryId,
    categoryName: cats.find((c) => c.id === p.categoryId)?.name ?? null,
    sellPriceCents: p.sell, isActive: p.active, catalogue: "shop", approvalStatus: "approved", updatedAt: minsAgo(5),
  };
  return costVisible(u) ? { ...base, costPriceCents: p.cost, marginCents: p.sell - p.cost } : base; // key ABSENT without permission
}
const need = (u: SessionUser, perm: string) => {
  if (!can(u, perm)) throw new ApiError("FORBIDDEN", "You do not have permission for this", 403);
};
const withCounts = (): Category[] => cats.map((c) => ({ ...c, productCount: products.filter((p) => p.categoryId === c.id && p.active).length }));
const sorted = () => [...cats].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

function page<T>(rows: T[], cursor?: string): Page<T> {
  const start = cursor ? parseInt(cursor, 10) || 0 : 0;
  const items = rows.slice(start, start + PAGE);
  return { items, nextCursor: start + PAGE < rows.length ? String(start + PAGE) : null };
}

function fingerprintOf(items: { productId: number; oldPriceCents: number; newPriceCents: number }[]): string {
  const text = items.map((i) => `${i.productId}:${i.oldPriceCents}:${i.newPriceCents}`).join("|");
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `mock${(h >>> 0).toString(16).padStart(8, "0")}${text.length.toString(16).padStart(8, "0")}`;
}
function bulkPlan(change: BulkChange) {
  if (!cats.some((c) => c.id === change.categoryId)) throw fail("INVALID_CATEGORY", "That category does not exist.", 400);
  const rows = products
    .filter((p) => p.categoryId === change.categoryId && (change.includeInactive || p.active))
    .map((p) => ({ id: p.id, name: p.name, sku: p.sku, sellPriceCents: p.sell }));
  const { items, skipped } = planBulk(rows, change);
  return { fingerprint: fingerprintOf(items), count: items.length, skippedCount: skipped.length, items, skipped };
}

// stock-takes
interface MTake {
  id: number;
  createdBy: number;
  creatorName: string;
  scope: StockTakeScope;
  status: StockTake["status"];
  note: string | null;
  createdAt: string;
  submittedAt: string | null;
  lines: Map<number, { counted: number; expected: number | null; variance: number | null; needs: boolean; applied: boolean }>;
  reviewNote?: string;
}
const takes: MTake[] = [];
let nextTake = 1;
const inScope = (t: MTake, p: MProduct) => p.active && (t.scope.type === "all" || p.categoryId === t.scope.categoryId);

function presentTake(t: MTake): StockTake {
  const lines = lineViews(t);
  return {
    id: t.id,
    scope: { type: t.scope.type, categoryId: t.scope.categoryId ?? null, categoryName: cats.find((c) => c.id === t.scope.categoryId)?.name ?? null },
    status: t.status, note: t.note, createdBy: { id: t.createdBy, name: t.creatorName }, createdAt: t.createdAt, submittedAt: t.submittedAt,
    lineCount: lines.length, varianceUnits: lines.reduce((n, l) => n + Math.abs(l.variance), 0), needsApprovalCount: lines.filter((l) => l.needsApproval).length,
    ...(t.reviewNote ? { reviewNote: t.reviewNote } : {}),
  };
}
function lineViews(t: MTake): StockTakeLine[] {
  const draft = t.status === "draft";
  return [...t.lines.entries()]
    .map(([pid, l]) => {
      const p = products.find((x) => x.id === pid) as MProduct;
      const system = draft ? p.stock : (l.expected as number);
      const variance = draft ? l.counted - p.stock : (l.variance as number);
      return { productId: pid, name: p.name, sku: p.sku, barcode: p.barcode, countedQty: l.counted, systemQty: system, variance, needsApproval: draft ? Math.abs(variance) > APPROVAL_LIMIT_UNITS : l.needs, applied: l.applied };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
const detail = (t: MTake): StockTakeDetail => ({ ...presentTake(t), lines: lineViews(t) });
function takeFor(u: SessionUser, id: number): MTake {
  const t = takes.find((x) => x.id === id);
  if (!t || (t.createdBy !== u.id && !can(u, "stock.review"))) throw fail("NOT_FOUND", "Stock-take not found.", 404);
  return t;
}

// payments
interface MPayment extends UnmatchedPayment {
  status: "unmatched" | "matched" | "ignored";
  raw: string;
}
const payments: MPayment[] = [
  { id: 1, source: "mpesa", method: "mobile_money", amountCents: 450_000, payerName: "Wanjiru K", reference: "QXA1B2C3", createdAt: minsAgo(240), ageMinutes: 240, status: "unmatched", raw: "254712345678" },
  { id: 2, source: "mpesa", method: "mobile_money", amountCents: 1_230_000, payerName: "Otieno B", reference: "QXD4E5F6", createdAt: minsAgo(95), ageMinutes: 95, status: "unmatched", raw: "" },
  { id: 3, source: "kcb", method: "bank_transfer", amountCents: 300_000, payerName: null, reference: "KCB-77120", createdAt: minsAgo(30), ageMinutes: 30, status: "unmatched", raw: "" },
];
interface MOrder { id: number; number: string; customer: string; phone: string; total: number; paid: number }
const payOrders: MOrder[] = [
  { id: 501, number: "UT123401", customer: "Wanjiru Kamau", phone: "0712345678", total: 450_000, paid: 0 },
  { id: 502, number: "UT123402", customer: "Brian Otieno", phone: "0722111222", total: 1_230_000, paid: 0 },
  { id: 503, number: "UT123403", customer: "Faith Njeri", phone: "0733555666", total: 800_000, paid: 200_000 },
  { id: 504, number: "UT123404", customer: "Peter Mwangi", phone: "0700123123", total: 150_000, paid: 0 },
];

// couriers
const orgs = [
  { id: 11, name: "Swift Riders", overdueAfter: 14 },
  { id: 12, name: "Mtaani Express", overdueAfter: 14 },
];
const collections: (CourierCollection & { courierId: number; settled: boolean })[] = [
  { courierId: 11, collectionId: 1, orderId: 601, orderNumber: "UT200101", customerName: "Achieng 1", amountCents: 450_000, feeCents: 30_000, collectedOn: dayAgo(25), settled: false },
  { courierId: 11, collectionId: 2, orderId: 602, orderNumber: "UT200102", customerName: "Kamau 2", amountCents: 820_000, feeCents: 30_000, collectedOn: dayAgo(9), settled: false },
  { courierId: 11, collectionId: 3, orderId: 603, orderNumber: "UT200103", customerName: "Njeri 3", amountCents: 310_000, feeCents: 30_000, collectedOn: dayAgo(2), settled: false },
  { courierId: 12, collectionId: 4, orderId: 604, orderNumber: "UT200104", customerName: "Otieno 4", amountCents: 560_000, feeCents: 40_000, collectedOn: dayAgo(1), settled: false },
];
const remittances: (CourierRemittance & { courierId: number })[] = [];
let nextRemit = 1;

// attendance, per user id
const shifts = new Map<number, { inAt: string | null; outAt: string | null }>();

export function createMockV11({ gate, userFor }: MockDeps): ApiV11 {
  const run = async <T,>(token: string, fn: (u: SessionUser) => T): Promise<T> => {
    await gate();
    return fn(userFor(token));
  };

  return {
    // ---------------------------------------------------------- catalog
    catalogSettings: (t) => run(t, (u) => (need(u, "products.manage"), { priceMaster: "pos" as const, pricePushOnline: false, pushImplemented: false })),

    products: (t, f) =>
      run(t, (u) => {
        need(u, "products.manage");
        const q = f.q?.trim().toLowerCase();
        const rows = products
          .filter((p) => p.active === (f.active ?? true))
          .filter((p) => (f.categoryId ? p.categoryId === f.categoryId : true))
          .filter((p) => (q ? [p.name, p.sku, p.barcode ?? ""].some((v) => v.toLowerCase().includes(q)) : true))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => present(u, p));
        return page(rows, f.cursor);
      }),

    product: (t, id) =>
      run(t, (u) => {
        need(u, "products.manage");
        const p = products.find((x) => x.id === id);
        if (!p) throw fail("NOT_FOUND", "Product not found.", 404);
        return present(u, p);
      }),

    createProduct: (t, d) =>
      run(t, (u) => {
        need(u, "products.manage");
        if (d.costPriceCents !== undefined && !costVisible(u)) throw new ApiError("FORBIDDEN", "You do not have permission to set buying prices.", 403);
        if (d.sellPriceCents <= 0) throw fail("INVALID_PRICE", "The selling price must be more than zero.", 400);
        if (products.some((p) => p.sku === d.sku)) throw fail("DUPLICATE_SKU", "Another product already uses that SKU.");
        if (d.barcode && products.some((p) => p.barcode === d.barcode)) throw fail("DUPLICATE_BARCODE", "Another product already uses that barcode.");
        const p: MProduct = { id: nextProduct++, sku: d.sku, barcode: d.barcode || null, name: d.name, categoryId: d.categoryId ?? null, sell: d.sellPriceCents, cost: d.costPriceCents ?? 0, active: d.isActive !== false, stock: 0 };
        products.push(p);
        return present(u, p);
      }),

    updateProduct: (t, id, patch) =>
      run(t, (u) => {
        need(u, "products.manage");
        const p = products.find((x) => x.id === id);
        if (!p) throw fail("NOT_FOUND", "Product not found.", 404);
        if (patch.costPriceCents !== undefined && !costVisible(u)) throw new ApiError("FORBIDDEN", "You do not have permission to set buying prices.", 403);
        const changing = patch.sellPriceCents !== undefined && patch.sellPriceCents !== p.sell;
        if (patch.sellPriceCents !== undefined && patch.sellPriceCents <= 0) throw fail("INVALID_PRICE", "The selling price must be more than zero.", 400);
        if (changing && (patch.reason ?? "").trim().length < 3) throw fail("REASON_REQUIRED", "Say why the price is changing.", 400);
        if (patch.sku && products.some((x) => x.id !== id && x.sku === patch.sku)) throw fail("DUPLICATE_SKU", "Another product already uses that SKU.");
        if (patch.barcode && products.some((x) => x.id !== id && x.barcode === patch.barcode)) throw fail("DUPLICATE_BARCODE", "Another product already uses that barcode.");
        if (changing) {
          history.unshift({ id: nextHistory++, productId: id, oldPriceCents: p.sell, newPriceCents: patch.sellPriceCents as number, reason: (patch.reason as string).trim(), source: "edit", batchId: null, changedBy: { id: u.id, name: u.name }, changedAt: new Date().toISOString() });
          p.sell = patch.sellPriceCents as number;
        }
        if (patch.name !== undefined) p.name = patch.name;
        if (patch.sku !== undefined) p.sku = patch.sku;
        if (patch.barcode !== undefined) p.barcode = patch.barcode || null;
        if (patch.categoryId !== undefined) p.categoryId = patch.categoryId;
        if (patch.costPriceCents !== undefined) p.cost = patch.costPriceCents;
        if (patch.isActive !== undefined) p.active = patch.isActive; // deactivated, never deleted
        return present(u, p);
      }),

    priceHistory: (t, productId, cursor) =>
      run(t, (u) => {
        need(u, "products.manage");
        return page(history.filter((h) => h.productId === productId).map(({ productId: _p, ...h }) => h), cursor);
      }),

    // ---------------------------------------------------------- categories
    categories: (t, includeInactive) =>
      run(t, (u) => {
        need(u, "products.manage");
        const counts = withCounts();
        return sorted().map((c) => counts.find((x) => x.id === c.id) as Category).filter((c) => includeInactive || c.isActive);
      }),
    createCategory: (t, name, parentId) =>
      run(t, (u) => {
        need(u, "products.manage");
        if (cats.some((c) => c.isActive && c.name.toLowerCase() === name.trim().toLowerCase() && c.parentId === (parentId ?? null))) throw fail("DUPLICATE_NAME", "There is already a category with that name.");
        const c: Category = { id: nextCat++, name: name.trim(), parentId: parentId ?? null, isActive: true, sortOrder: Math.max(-1, ...cats.map((x) => x.sortOrder)) + 1, productCount: 0 };
        cats.push(c);
        return c;
      }),
    updateCategory: (t, id, patch) =>
      run(t, (u) => {
        need(u, "products.manage");
        const c = cats.find((x) => x.id === id);
        if (!c) throw fail("NOT_FOUND", "Category not found.", 404);
        const name = patch.name?.trim() ?? c.name;
        const active = patch.isActive ?? c.isActive;
        if (active && cats.some((x) => x.id !== id && x.isActive && x.name.toLowerCase() === name.toLowerCase() && x.parentId === c.parentId)) throw fail("DUPLICATE_NAME", "There is already a category with that name.");
        c.name = name;
        c.isActive = active; // products filed under it are not touched
        return { ...c, productCount: products.filter((p) => p.categoryId === id && p.active).length };
      }),
    reorderCategories: (t, ids) =>
      run(t, (u) => {
        need(u, "products.manage");
        if (new Set(ids).size !== ids.length || ids.some((i) => !cats.some((c) => c.id === i))) throw fail("INVALID_ORDER", "That order is not valid.", 400);
        ids.forEach((cid, i) => {
          (cats.find((c) => c.id === cid) as Category).sortOrder = i;
        });
        const counts = withCounts();
        return sorted().map((c) => counts.find((x) => x.id === c.id) as Category);
      }),

    // ---------------------------------------------------------- bulk prices
    bulkPreview: (t, change) => run(t, (u) => (need(u, "prices.bulk"), bulkPlan(change))),
    bulkApply: (t, change, reason, fingerprint) =>
      run(t, (u) => {
        need(u, "prices.bulk");
        if (reason.trim().length < 3) throw fail("REASON_REQUIRED", "Say why the prices are changing.", 400);
        const plan = bulkPlan(change);
        if (plan.fingerprint !== fingerprint) throw fail("PREVIEW_STALE", "Prices changed since you previewed. Preview again before applying.");
        if (plan.count === 0) throw fail("NOTHING_TO_CHANGE", "Nothing would change.", 422);
        const id = nextBatch++;
        for (const i of plan.items) {
          (products.find((p) => p.id === i.productId) as MProduct).sell = i.newPriceCents;
          history.unshift({ id: nextHistory++, productId: i.productId, oldPriceCents: i.oldPriceCents, newPriceCents: i.newPriceCents, reason, source: "bulk", batchId: id, changedBy: { id: u.id, name: u.name }, changedAt: new Date().toISOString() });
        }
        batches.unshift({ id, kind: "bulk", categoryId: change.categoryId, categoryName: cats.find((c) => c.id === change.categoryId)?.name ?? null, mode: change.mode, value: change.value, reason, productCount: plan.count, createdBy: { id: u.id, name: u.name }, createdAt: new Date().toISOString(), revertedAt: null, revertsBatchId: null });
        return { batchId: id, count: plan.count, appliedAt: new Date().toISOString() };
      }),
    bulkBatches: (t, cursor) => run(t, (u) => (need(u, "prices.bulk"), page(batches, cursor))),
    bulkRevert: (t, batchId, reason) =>
      run(t, (u) => {
        need(u, "prices.bulk");
        const b = batches.find((x) => x.id === batchId);
        if (!b) throw fail("NOT_FOUND", "Batch not found.", 404);
        if (b.kind !== "bulk") throw fail("NOT_REVERTIBLE", "Only a price change can be reverted, not a revert.");
        if (b.revertedAt) throw fail("ALREADY_REVERTED", "This batch was already reverted.");
        const mine = history.filter((h) => h.batchId === batchId && h.source === "bulk");
        const skipped: { productId: number; name: string; reason: string }[] = [];
        const id = nextBatch++;
        let count = 0;
        const why = reason?.trim() || `Reverted price change #${batchId}`;
        for (const h of mine) {
          const p = products.find((x) => x.id === h.productId) as MProduct;
          if (p.sell !== h.newPriceCents) {
            skipped.push({ productId: p.id, name: p.name, reason: "PRICE_CHANGED_SINCE" });
            continue;
          }
          p.sell = h.oldPriceCents;
          history.unshift({ id: nextHistory++, productId: p.id, oldPriceCents: h.newPriceCents, newPriceCents: h.oldPriceCents, reason: why, source: "bulk_revert", batchId: id, changedBy: { id: u.id, name: u.name }, changedAt: new Date().toISOString() });
          count++;
        }
        if (count === 0) {
          nextBatch--;
          throw fail("NOTHING_TO_REVERT", "Every product has been repriced since, so there is nothing to revert.");
        }
        b.revertedAt = new Date().toISOString();
        batches.unshift({ id, kind: "bulk_revert", categoryId: b.categoryId, categoryName: b.categoryName, mode: "revert", value: 0, reason: why, productCount: count, createdBy: { id: u.id, name: u.name }, createdAt: new Date().toISOString(), revertedAt: null, revertsBatchId: batchId });
        return { batchId: id, count, skipped };
      }),

    // ---------------------------------------------------------- stock-take
    stockTakes: (t, f) =>
      run(t, (u) => {
        need(u, "stock.count");
        const onlyMine = f.mine || !can(u, "stock.review");
        const rows = takes
          .filter((x) => (onlyMine ? x.createdBy === u.id : true) && (f.status ? x.status === f.status : true))
          .sort((a, b) => b.id - a.id)
          .map(presentTake);
        return page(rows, f.cursor);
      }),
    stockTake: (t, id) => run(t, (u) => (need(u, "stock.count"), detail(takeFor(u, id)))),
    startStockTake: (t, scope, note) =>
      run(t, (u) => {
        need(u, "stock.count");
        if (scope.type === "category" && !cats.some((c) => c.id === scope.categoryId)) throw fail("INVALID_CATEGORY", "That category does not exist.", 400);
        const existing = takes.find((x) => x.createdBy === u.id && x.status === "draft" && x.scope.type === scope.type && (x.scope.categoryId ?? null) === (scope.categoryId ?? null));
        if (existing) return presentTake(existing); // resume
        const tk: MTake = { id: nextTake++, createdBy: u.id, creatorName: u.name, scope, status: "draft", note: note ?? null, createdAt: new Date().toISOString(), submittedAt: null, lines: new Map() };
        takes.push(tk);
        return presentTake(tk);
      }),
    stockTakeProducts: (t, id, q) =>
      run(t, (u) => {
        need(u, "stock.count");
        const tk = takeFor(u, id);
        const needle = q.q?.trim().toLowerCase();
        return products
          .filter((p) => inScope(tk, p))
          .filter((p) => (q.barcode ? p.barcode === q.barcode : needle ? [p.name, p.sku, p.barcode ?? ""].some((v) => v.toLowerCase().includes(needle)) : false))
          .slice(0, 20)
          .map((p) => ({ productId: p.id, name: p.name, sku: p.sku, barcode: p.barcode, systemQty: p.stock }));
      }),
    saveStockTakeLines: (t, id, lines) =>
      run(t, (u) => {
        need(u, "stock.count");
        const tk = takeFor(u, id);
        if (tk.createdBy !== u.id) throw new ApiError("FORBIDDEN", "Only the person who started this stock-take can change it.", 403);
        if (tk.status !== "draft") throw fail("NOT_DRAFT", "This stock-take has already been submitted.");
        for (const l of lines) {
          const p = products.find((x) => x.id === l.productId);
          if (!p || !inScope(tk, p)) throw fail("NOT_IN_SCOPE", `Product ${l.productId} is not part of this stock-take.`, 422);
          if (!Number.isInteger(l.countedQty) || l.countedQty < 0) throw fail("UNKNOWN" as ApiErrorCode, "Counts are whole numbers, zero or more.", 400);
        }
        for (const l of lines) tk.lines.set(l.productId, { counted: l.countedQty, expected: null, variance: null, needs: false, applied: false });
        return detail(tk);
      }),
    submitStockTake: (t, id) =>
      run(t, (u) => {
        need(u, "stock.count");
        const tk = takeFor(u, id);
        if (tk.createdBy !== u.id) throw new ApiError("FORBIDDEN", "Only the person who started this stock-take can change it.", 403);
        if (tk.status !== "draft") throw fail("NOT_DRAFT", "This stock-take has already been submitted.");
        if (tk.lines.size === 0) throw fail("NO_LINES", "Count at least one product before submitting.", 422);
        const applied: { productId: number; variance: number }[] = [];
        const pendingApproval: { productId: number; variance: number }[] = [];
        for (const [pid, l] of tk.lines) {
          const p = products.find((x) => x.id === pid) as MProduct;
          const variance = l.counted - p.stock;
          const needs = Math.abs(variance) > APPROVAL_LIMIT_UNITS;
          Object.assign(l, { expected: p.stock, variance, needs, applied: false });
          if (variance !== 0 && !needs) {
            p.stock = l.counted;
            l.applied = true;
            applied.push({ productId: pid, variance });
          } else if (needs) pendingApproval.push({ productId: pid, variance });
        }
        tk.status = pendingApproval.length ? "pending_approval" : "applied";
        tk.submittedAt = new Date().toISOString();
        const total = products.filter((p) => inScope(tk, p)).length;
        return { status: tk.status as "applied" | "pending_approval", applied, pendingApproval, notCountedCount: Math.max(total - tk.lines.size, 0) };
      }),
    approveStockTake: (t, id, note) => run(t, (u) => decideTake(u, id, true, note)),
    rejectStockTake: (t, id, reason) =>
      run(t, (u) => {
        if (reason.trim().length < 3) throw fail("UNKNOWN" as ApiErrorCode, "Say why you are rejecting it.", 400);
        return decideTake(u, id, false, reason);
      }),

    // ---------------------------------------------------------- payments
    unmatchedPayments: (t, cursor) =>
      run(t, (u) => {
        need(u, "payments.reconcile");
        const open = payments.filter((p) => p.status === "unmatched");
        const p = page(open.map(({ status: _s, raw: _r, ...rest }) => ({ ...rest, ageMinutes: Math.floor((Date.now() - Date.parse(rest.createdAt)) / 60000) })), cursor);
        return { ...p, total: open.length, unallocatedCents: open.reduce((n, x) => n + x.amountCents, 0) };
      }),
    paymentSuggestions: (t, id, q) =>
      run(t, (u) => {
        need(u, "payments.reconcile");
        const pay = paymentFor(id);
        if (pay.status !== "unmatched") throw fail(pay.status === "matched" ? "ALREADY_MATCHED" : "ALREADY_IGNORED", `This payment was already ${pay.status}.`);
        const needle = q?.trim().toLowerCase();
        const words = new Set((pay.payerName ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
        return payOrders
          .map((o) => {
            const balance = o.total - o.paid;
            const reasons: ("amount" | "phone" | "name")[] = [];
            let score = 0;
            if (balance === pay.amountCents) (reasons.push("amount"), (score += 100));
            if (pay.raw && pay.raw.endsWith(o.phone.slice(-9))) (reasons.push("phone"), (score += 60));
            const shared = o.customer.toLowerCase().split(/\s+/).filter((w) => words.has(w));
            if (shared.length) (reasons.push("name"), (score += 20 * shared.length));
            const searched = !!needle && [o.customer, o.phone, o.number].some((v) => v.toLowerCase().includes(needle));
            return { o, balance, reasons, score, searched };
          })
          .filter((x) => x.balance > 0 && (x.score > 0 || x.searched))
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map((x) => ({ orderId: x.o.id, number: x.o.number, customerName: x.o.customer, customerPhone: x.o.phone, totalCents: x.o.total, balanceCents: x.balance, status: x.o.paid > 0 ? "dispatched_partial" : "dispatched_unpaid", score: x.score, reasons: x.reasons }));
      }),
    matchPayment: (t, id, orderId) =>
      run(t, (u) => {
        need(u, "payments.reconcile");
        const pay = paymentFor(id);
        if (pay.status !== "unmatched") throw fail(pay.status === "matched" ? "ALREADY_MATCHED" : "ALREADY_IGNORED", `This payment was already ${pay.status === "matched" ? "matched to an order" : "ignored"}.`);
        const o = payOrders.find((x) => x.id === orderId);
        if (!o) throw fail("ORDER_NOT_FOUND", "Order not found.", 404);
        const balance = o.total - o.paid;
        if (balance <= 0) throw fail("ORDER_NOT_PAYABLE", "That order cannot take a payment right now.");
        if (pay.amountCents > balance) throw fail("AMOUNT_EXCEEDS_BALANCE", `The payment is more than the ${balance} still owed on that order.`, 422);
        o.paid += pay.amountCents;
        pay.status = "matched";
        const after = o.total - o.paid;
        return { payment: { id, status: "matched" as const }, order: { id: o.id, number: o.number, paymentState: (after <= 0 ? "paid" : "partial") as "paid" | "partial", balanceCents: Math.max(after, 0) } };
      }),
    ignorePayment: (t, id, reason) =>
      run(t, (u) => {
        need(u, "payments.reconcile");
        if (reason.trim().length < 3) throw fail("UNKNOWN" as ApiErrorCode, "Say why you are setting this payment aside.", 400);
        const pay = paymentFor(id);
        if (pay.status !== "unmatched") throw fail(pay.status === "matched" ? "ALREADY_MATCHED" : "ALREADY_IGNORED", `This payment was already ${pay.status}.`);
        pay.status = "ignored";
      }),

    // ---------------------------------------------------------- couriers
    courierBalances: (t) =>
      run(t, (u) => {
        need(u, "couriers.settle");
        return orgs
          .map((o) => {
            const open = collections.filter((c) => c.courierId === o.id && !c.settled);
            const out = open.reduce((n, c) => n + c.amountCents - c.feeCents, 0);
            const ageOf = (c: { collectedOn: string }) => Math.floor((Date.now() - Date.parse(c.collectedOn)) / 86_400_000);
            const overdue = open.filter((c) => ageOf(c) > o.overdueAfter).reduce((n, c) => n + c.amountCents - c.feeCents, 0);
            const bucket = (lo: number, hi: number) => open.filter((c) => ageOf(c) >= lo && ageOf(c) <= hi).reduce((n, c) => n + c.amountCents - c.feeCents, 0);
            return {
              courierId: o.id, name: o.name, kind: "organization", outstandingCents: out, overdueCents: overdue, paused: false, openCollections: open.length,
              oldestCollectionOn: open.map((c) => c.collectedOn).sort()[0] ?? null,
              buckets: [{ label: "0-7", cents: bucket(0, 7) }, { label: "8-14", cents: bucket(8, 14) }, { label: "15-30", cents: bucket(15, 30) }, { label: "30+", cents: bucket(31, 9999) }],
            };
          })
          .sort((a, b) => b.outstandingCents - a.outstandingCents);
      }),
    courierCollections: (t, courierId) =>
      run(t, (u) => {
        need(u, "couriers.settle");
        if (!orgs.some((o) => o.id === courierId)) throw fail("NOT_FOUND", "Organization not found.", 404);
        return collections.filter((c) => c.courierId === courierId && !c.settled).map(({ courierId: _c, settled: _s, ...c }) => c);
      }),
    courierRemittances: (t, courierId, cursor) =>
      run(t, (u) => {
        need(u, "couriers.settle");
        return page(remittances.filter((r) => r.courierId === courierId).map(({ courierId: _c, ...r }) => r), cursor);
      }),
    createRemittance: (t, courierId, req) =>
      run(t, (u) => {
        need(u, "couriers.settle");
        if (!orgs.some((o) => o.id === courierId)) throw fail("NOT_FOUND", "Organization not found.", 404);
        if (req.collectionIds.length === 0 || req.remittedCents < 0) throw fail("UNKNOWN" as ApiErrorCode, "Tick at least one parcel and enter the amount received.", 400);
        const cols = req.collectionIds.map((id) => collections.find((c) => c.collectionId === id));
        if (cols.some((c) => !c)) throw fail("NOT_FOUND", "One of the listed parcels does not exist.", 404);
        const real = cols as NonNullable<(typeof cols)[number]>[];
        if (real.some((c) => c.courierId !== courierId)) throw fail("STATEMENT_WRONG_ORGANIZATION", "A parcel was collected by a different organization.");
        if (real.some((c) => c.settled)) throw fail("ALREADY_SETTLED", "One of those parcels was already settled on another remittance.");
        const collected = real.reduce((n, c) => n + c.amountCents, 0);
        const fees = real.reduce((n, c) => n + c.feeCents, 0);
        if (req.remittedCents + fees > collected) throw fail("STATEMENT_EXCEEDS_COLLECTIONS", "The remittance plus the fees owed is more than they collected.", 422);
        if (req.remittedCents + fees <= 0) throw fail("STATEMENT_NOTHING_SETTLED", "Nothing was remitted, so there is nothing to settle.", 422);
        real.forEach((c) => (c.settled = true)); // immutable once recorded
        const id = nextRemit++;
        const expected = collected - fees;
        remittances.unshift({ id, courierId, createdAt: new Date().toISOString(), createdBy: { id: u.id, name: u.name }, collectionsCents: collected, feesCents: fees, remittedCents: req.remittedCents, cashVarianceCents: expected - req.remittedCents, reference: req.reference?.trim() || null });
        return { id, remittedCents: req.remittedCents, expectedCents: expected, cashVarianceCents: expected - req.remittedCents, settledCount: real.length };
      }),

    // ---------------------------------------------------------- attendance
    attendanceToday: (t) => run(t, (u) => todayOf(u)),
    clockIn: (t) =>
      run(t, (u) => {
        const s = shifts.get(u.id);
        if (s?.inAt) throw fail("ALREADY_CLOCKED_IN", "Already clocked in today.");
        shifts.set(u.id, { inAt: new Date().toISOString(), outAt: null });
        return todayOf(u);
      }),
    clockOut: (t, req) =>
      run(t, (u) => {
        const s = shifts.get(u.id);
        if (!s?.inAt) throw fail("NOT_CLOCKED_IN", "Not clocked in today.");
        if (s.outAt) throw fail("ALREADY_CLOCKED_OUT", "Already clocked out today.");
        const open = openOrdersFor(u);
        const notes = (req.handoverNotes ?? "").trim();
        if (open === 0) {
          if (!req.confirmAllDispatched || !req.confirmNairobiReconciled) throw fail("CLOCKOUT_CONFIRMATION_REQUIRED", "Confirm that everything is dispatched and the Nairobi parcels are reconciled.", 422);
        } else {
          if (req.confirmAllDispatched) throw fail("CLOCKOUT_CONFIRMATION_FALSE", "You ticked 'all dispatched' but orders are still waiting.", 422);
          if (notes.length < 10) throw fail("CLOCKOUT_REASON_REQUIRED", "Explain what is still open (at least 10 characters).", 422);
        }
        s.outAt = new Date().toISOString();
        return todayOf(u);
      }),
  };

  // ------------------------------------------------------------ inner helpers
  function decideTake(u: SessionUser, id: number, approve: boolean, note?: string): StockTakeDetail {
    need(u, "stock.review");
    const tk = takes.find((x) => x.id === id);
    if (!tk) throw fail("NOT_FOUND", "Stock-take not found.", 404);
    if (tk.status !== "pending_approval") throw fail("NOT_PENDING", "This stock-take is not waiting for a decision.");
    if (tk.createdBy === u.id && u.role !== "owner") throw new ApiError("SELF_APPROVAL", "You counted this stock, so someone else has to decide on it.", 403);
    if (approve) {
      for (const [pid, l] of tk.lines) {
        if (l.needs && !l.applied) {
          (products.find((p) => p.id === pid) as MProduct).stock += l.variance as number;
          l.applied = true;
        }
      }
    }
    tk.status = approve ? "applied" : "rejected";
    if (note) tk.reviewNote = note;
    return detail(tk);
  }
  function paymentFor(id: number): MPayment {
    const p = payments.find((x) => x.id === id);
    if (!p) throw fail("NOT_FOUND", "Payment not found.", 404);
    return p;
  }
  function openOrdersFor(u: SessionUser): number {
    return u.username === "manager" ? 2 : 0; // the manager has two orders still waiting to go out, so the gate's reason path can be tried
  }
  function todayOf(u: SessionUser): AttendanceToday {
    const s = shifts.get(u.id);
    const status = !s?.inAt ? "not_started" : s.outAt ? "clocked_out" : "clocked_in";
    const open = openOrdersFor(u);
    return {
      workDate: new Date().toISOString().slice(0, 10), status, clockInAt: s?.inAt ?? null, clockOutAt: s?.outAt ?? null,
      gate: status === "clocked_in"
        ? { mode: "reason", blocked: false, reasonRequired: open > 0, canConfirmDispatched: open === 0, canConfirmNairobi: true, undispatchedOrders: open, nairobiUnpaid: 0, custodyOpen: 0, unmatchedPayments: payments.filter((p) => p.status === "unmatched").length }
        : null,
    };
  }
}

