import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { audit } from '../pos/audit.js';

// Stock on hand is the sum of a product's movements. Anything that sells, dispatches, voids or refunds goes through here, inside the
// same transaction as the sale or dispatch itself, so the goods and the paperwork stand or fall together.

export type MovementType = 'receipt' | 'adjustment' | 'write_off' | 'sale' | 'void_reversal' | 'refund_restock' | 'dispatch' | 'return_restock';

export interface LineIn { sku?: string | null; name: string; quantity: number }
export interface ResolvedLine { productId: number | null; tracked: boolean }

/** When on, every line must name a known product. Off by default so free-typed items still work; switch on before cutover. */
export async function isStrict(db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'stock.strict'`);
  return rows[0]?.value === 'true';
}

export async function setStrict(pool: Pool, input: { strict: boolean; actor: string; role?: string }): Promise<void> {
  await withTransaction(pool, async (c) => {
    await c.query(`INSERT INTO settings (key, value) VALUES ('stock.strict', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [String(input.strict)]);
    await audit(c, { actor: input.actor, role: input.role, action: 'stock_strict_changed', entityType: 'setting', entityId: 'stock.strict', risk: 1, details: { strict: input.strict } });
  });
}

/** Matches each line's SKU to a product. A deactivated product is refused; an unknown SKU is refused only in strict mode. */
export async function resolveLines(db: Queryable, lines: LineIn[]): Promise<ResolvedLine[]> {
  const strict = await isStrict(db);
  const skus = [...new Set(lines.map((l) => l.sku?.trim().toUpperCase()).filter((s): s is string => !!s))];
  const found = skus.length
    ? (await db.query<{ id: number; sku: string; name: string; track_stock: boolean; active: boolean }>(`SELECT id, sku, name, track_stock, active FROM products WHERE sku = ANY($1)`, [skus])).rows
    : [];
  const bySku = new Map(found.map((p) => [p.sku, p]));
  return lines.map((l) => {
    const sku = l.sku?.trim().toUpperCase();
    if (!sku) {
      if (strict) throw new HttpError(422, 'ITEM_NEEDS_SKU', `"${l.name}" needs a product code (SKU).`);
      return { productId: null, tracked: false };
    }
    const p = bySku.get(sku);
    if (!p) {
      if (strict) throw new HttpError(422, 'UNKNOWN_PRODUCT', `There is no product with the code "${l.sku}". Add it to the catalog first.`);
      return { productId: null, tracked: false };
    }
    if (!p.active) throw new HttpError(422, 'PRODUCT_INACTIVE', `"${p.name}" (${p.sku}) is deactivated and cannot be sold.`);
    return { productId: p.id, tracked: p.track_stock };
  });
}

/** Quantity needed per tracked product. */
export function needs(lines: LineIn[], resolved: ResolvedLine[]): Map<number, number> {
  const m = new Map<number, number>();
  lines.forEach((l, i) => {
    const r = resolved[i]!;
    if (r.productId !== null && r.tracked) m.set(r.productId, (m.get(r.productId) ?? 0) + l.quantity);
  });
  return m;
}

export const onHand = async (db: Queryable, productId: number): Promise<number> =>
  Number((await db.query<{ s: string }>(`SELECT COALESCE(sum(quantity), 0) AS s FROM stock_movements WHERE product_id = $1`, [productId])).rows[0]!.s);

/** Promised to orders that are awaiting dispatch but not yet taken out of stock. */
export const reserved = async (db: Queryable, productId: number): Promise<number> =>
  Number((await db.query<{ s: string }>(
    `SELECT COALESCE(sum(i.quantity), 0) AS s FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.product_id = $1 AND o.status = 'awaiting_dispatch'`, [productId])).rows[0]!.s);

/**
 * Locks the products (always in id order, so two people never deadlock) and refuses if any is short.
 * mode 'available': what is on hand minus what awaiting orders already hold (new orders and counter sales).
 * mode 'on_hand':   what is physically there (dispatching an order that is itself one of the holds).
 */
export async function lockAndCheck(db: Queryable, need: Map<number, number>, mode: 'available' | 'on_hand'): Promise<void> {
  if (need.size === 0) return;
  const ids = [...need.keys()].sort((a, b) => a - b);
  const { rows } = await db.query<{ id: number; sku: string; name: string }>(`SELECT id, sku, name FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE`, [ids]);
  const short: { sku: string; name: string; requested: number; available: number }[] = [];
  for (const p of rows) {
    const have = (await onHand(db, p.id)) - (mode === 'available' ? await reserved(db, p.id) : 0);
    if (have < need.get(p.id)!) short.push({ sku: p.sku, name: p.name, requested: need.get(p.id)!, available: Math.max(have, 0) });
  }
  if (short.length) {
    throw new HttpError(409, 'INSUFFICIENT_STOCK', `Not enough stock: ${short.map((s) => `${s.name} (${s.sku}) has ${s.available}, ${s.requested} needed`).join('; ')}.`, short);
  }
}

export interface MovementIn {
  productId: number; type: MovementType; quantity: number; actor: string;
  reason?: string; unitCostCents?: number; ref?: { type: 'order' | 'sale' | 'refund'; id: number };
}

export async function postMovements(db: Queryable, rows: MovementIn[]): Promise<void> {
  for (const m of rows) {
    await db.query(
      `INSERT INTO stock_movements (product_id, type, quantity, unit_cost_cents, reason, ref_type, ref_id, actor) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [m.productId, m.type, m.quantity, m.unitCostCents ?? null, m.reason?.trim() || null, m.ref?.type ?? null, m.ref?.id ?? null, m.actor]);
  }
}

// ---------------------------------------------------------------------------------------------- manual stock changes

const whole = (v: unknown, label: string) => {
  if (!Number.isSafeInteger(v) || (v as number) === 0) throw new HttpError(422, 'STOCK_BAD_QUANTITY', `${label} must be a whole number, not zero.`);
  return v as number;
};

async function trackedProduct(c: Queryable, productId: number) {
  const { rows } = await c.query<{ id: number; sku: string; name: string; track_stock: boolean; active: boolean }>(`SELECT id, sku, name, track_stock, active FROM products WHERE id = $1 FOR UPDATE`, [productId]);
  const p = rows[0];
  if (!p) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
  if (!p.track_stock) throw new HttpError(409, 'PRODUCT_NOT_TRACKED', `${p.name} is not stock-tracked.`);
  return p;
}

/** Goods arriving. Always positive. */
export async function receiveStock(pool: Pool, input: { productId: number; quantity: number; unitCostCents?: number; note?: string; actor: string; role?: string }) {
  const q = whole(input.quantity, 'The quantity');
  if (q < 0) throw new HttpError(422, 'STOCK_BAD_QUANTITY', 'Goods received must be a positive number. Use an adjustment or write-off to take stock out.');
  if (input.unitCostCents !== undefined && (!Number.isSafeInteger(input.unitCostCents) || input.unitCostCents < 0)) throw new HttpError(422, 'STOCK_BAD_COST', 'The unit cost must be a whole number of cents.');
  return withTransaction(pool, async (c) => {
    const p = await trackedProduct(c, input.productId);
    await postMovements(c, [{ productId: p.id, type: 'receipt', quantity: q, actor: input.actor, reason: input.note, unitCostCents: input.unitCostCents }]);
    await audit(c, { actor: input.actor, role: input.role, action: 'stock_received', entityType: 'product', entityId: p.id, details: { sku: p.sku, quantity: q, note: input.note ?? null } });
    return { productId: p.id, onHand: await onHand(c, p.id) };
  });
}

/** A stock count correction, up or down, always with a reason. A reduction below what is on hand is refused. */
export async function adjustStock(pool: Pool, input: { productId: number; delta: number; reason: string; actor: string; role?: string }) {
  const d = whole(input.delta, 'The change');
  if (!input.reason?.trim()) throw new HttpError(422, 'STOCK_REASON_REQUIRED', 'A stock adjustment needs a reason.');
  return withTransaction(pool, async (c) => {
    const p = await trackedProduct(c, input.productId);
    if (d < 0) await lockAndCheck(c, new Map([[p.id, -d]]), 'on_hand');
    await postMovements(c, [{ productId: p.id, type: 'adjustment', quantity: d, actor: input.actor, reason: input.reason }]);
    await audit(c, { actor: input.actor, role: input.role, action: 'stock_adjusted', entityType: 'product', entityId: p.id, risk: d < 0 ? 2 : 1, details: { sku: p.sku, delta: d, reason: input.reason.trim() } });
    return { productId: p.id, onHand: await onHand(c, p.id) };
  });
}

/** Goods lost, damaged or disposed of. Always negative, always with a reason. */
export async function writeOffStock(pool: Pool, input: { productId: number; quantity: number; reason: string; actor: string; role?: string }) {
  const q = whole(input.quantity, 'The quantity');
  if (q < 0) throw new HttpError(422, 'STOCK_BAD_QUANTITY', 'Enter how many to write off as a positive number.');
  if (!input.reason?.trim()) throw new HttpError(422, 'STOCK_REASON_REQUIRED', 'A write-off needs a reason.');
  return withTransaction(pool, async (c) => {
    const p = await trackedProduct(c, input.productId);
    await lockAndCheck(c, new Map([[p.id, q]]), 'on_hand');
    await postMovements(c, [{ productId: p.id, type: 'write_off', quantity: -q, actor: input.actor, reason: input.reason }]);
    await audit(c, { actor: input.actor, role: input.role, action: 'stock_written_off', entityType: 'product', entityId: p.id, risk: 2, details: { sku: p.sku, quantity: q, reason: input.reason.trim() } });
    return { productId: p.id, onHand: await onHand(c, p.id) };
  });
}

export interface MovementView { id: number; productId: number; sku: string; type: MovementType; quantity: number; unitCostCents: number | null; reason: string | null; refType: string | null; refId: number | null; actor: string; at: Date }

export async function listMovements(db: Queryable, opts: { productId?: number; limit: number; offset: number }): Promise<{ movements: MovementView[]; total: number }> {
  const where = opts.productId ? 'WHERE m.product_id = $1' : '';
  const args = opts.productId ? [opts.productId] : [];
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM stock_movements m ${where}`, args)).rows[0]!.n);
  const { rows } = await db.query(
    `SELECT m.*, p.sku FROM stock_movements m JOIN products p ON p.id = m.product_id ${where} ORDER BY m.id DESC LIMIT ${opts.limit} OFFSET ${opts.offset}`, args);
  return { total, movements: rows.map((r) => ({ id: r.id, productId: r.product_id, sku: r.sku, type: r.type, quantity: r.quantity, unitCostCents: r.unit_cost_cents, reason: r.reason, refType: r.ref_type, refId: r.ref_id, actor: r.actor, at: r.at })) };
}
