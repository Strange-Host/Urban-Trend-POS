import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { audit } from '../pos/audit.js';

export interface ProductView {
  id: number; sku: string; name: string; category: string | null; priceCents: number; costCents: number; trackStock: boolean;
  reorderLevel: number; active: boolean; createdAt: Date;
  /** Physically in stock: the sum of its movements. */
  onHand: number;
  /** Promised to orders awaiting dispatch. */
  reserved: number;
  /** What can still be promised: on hand minus reserved. */
  available: number;
  lowStock: boolean;
}

const SELECT = `
  SELECT p.*,
         COALESCE((SELECT sum(m.quantity) FROM stock_movements m WHERE m.product_id = p.id), 0)::bigint AS on_hand,
         COALESCE((SELECT sum(i.quantity) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.product_id = p.id AND o.status = 'awaiting_dispatch'), 0)::bigint AS reserved
    FROM products p`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toView = (r: any): ProductView => ({
  id: r.id, sku: r.sku, name: r.name, category: r.category, priceCents: r.price_cents, costCents: r.cost_cents, trackStock: r.track_stock,
  reorderLevel: r.reorder_level, active: r.active, createdAt: r.created_at,
  onHand: r.on_hand, reserved: r.reserved, available: r.on_hand - r.reserved,
  lowStock: r.track_stock && r.active && r.on_hand - r.reserved <= r.reorder_level,
});

const cents = (v: unknown, label: string) => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new HttpError(422, 'PRODUCT_BAD_AMOUNT', `${label} must be a whole number of cents, zero or more.`);
  return v as number;
};
const SKU_RE = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;

export async function getProduct(db: Queryable, id: number): Promise<ProductView | null> {
  const { rows } = await db.query(`${SELECT} WHERE p.id = $1`, [id]);
  return rows[0] ? toView(rows[0]) : null;
}

export async function listProducts(db: Queryable, opts: { search?: string; category?: string; active?: boolean; lowOnly?: boolean; limit: number; offset: number }): Promise<{ products: ProductView[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.search?.trim()) { args.push(`%${opts.search.trim().replace(/[%_\\]/g, '\\$&')}%`); where.push(`(p.sku ILIKE $${args.length} OR p.name ILIKE $${args.length})`); }
  if (opts.category) { args.push(opts.category); where.push(`p.category = $${args.length}`); }
  if (opts.active !== undefined) { args.push(opts.active); where.push(`p.active = $${args.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // lowOnly is applied after the stock figures are known, so it filters the derived column.
  const inner = `SELECT * FROM (${SELECT} ${clause}) x ${opts.lowOnly ? `WHERE x.track_stock AND x.active AND x.on_hand - x.reserved <= x.reorder_level` : ''}`;
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM (${inner}) y`, args)).rows[0]!.n);
  const { rows } = await db.query(`${inner} ORDER BY x.name, x.id LIMIT ${opts.limit} OFFSET ${opts.offset}`, args);
  return { total, products: rows.map(toView) };
}

export async function createProduct(pool: Pool, input: {
  sku: string; name: string; category?: string; priceCents: number; costCents?: number; trackStock?: boolean; reorderLevel?: number; actor: string; role?: string;
}): Promise<ProductView> {
  const sku = input.sku.trim().toUpperCase();
  if (!SKU_RE.test(sku)) throw new HttpError(422, 'PRODUCT_BAD_SKU', 'A SKU is up to 40 characters: letters, digits, dot, dash or underscore.');
  if (!input.name?.trim()) throw new HttpError(422, 'PRODUCT_NO_NAME', 'A product needs a name.');
  const price = cents(input.priceCents, 'The price');
  const cost = cents(input.costCents ?? 0, 'The cost');
  const reorder = input.reorderLevel ?? 0;
  if (!Number.isSafeInteger(reorder) || reorder < 0) throw new HttpError(422, 'PRODUCT_BAD_REORDER', 'The reorder level must be a whole number, zero or more.');
  try {
    return await withTransaction(pool, async (c) => {
      const { rows } = await c.query<{ id: number }>(
        `INSERT INTO products (sku, name, category, price_cents, cost_cents, track_stock, reorder_level, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [sku, input.name.trim(), input.category?.trim() || null, price, cost, input.trackStock ?? true, reorder, input.actor]);
      await audit(c, { actor: input.actor, role: input.role, action: 'product_created', entityType: 'product', entityId: rows[0]!.id, details: { sku, price_cents: price } });
      return (await getProduct(c, rows[0]!.id))!;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'SKU_TAKEN', `The code ${sku} is already used by another product.`);
    throw err;
  }
}

/** Price, cost, name and the like can change (orders keep their own copy of the price they sold at). The SKU never does. */
export async function updateProduct(pool: Pool, input: {
  id: number; name?: string; category?: string | null; priceCents?: number; costCents?: number; trackStock?: boolean; reorderLevel?: number; active?: boolean; actor: string; role?: string;
}): Promise<ProductView> {
  return withTransaction(pool, async (c) => {
    const { rows } = await c.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [input.id]);
    const p = rows[0];
    if (!p) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
    if (input.name !== undefined && !input.name.trim()) throw new HttpError(422, 'PRODUCT_NO_NAME', 'A product needs a name.');
    if (input.reorderLevel !== undefined && (!Number.isSafeInteger(input.reorderLevel) || input.reorderLevel < 0)) throw new HttpError(422, 'PRODUCT_BAD_REORDER', 'The reorder level must be a whole number, zero or more.');
    const price = input.priceCents === undefined ? p.price_cents : cents(input.priceCents, 'The price');
    const cost = input.costCents === undefined ? p.cost_cents : cents(input.costCents, 'The cost');
    if (input.trackStock !== undefined && input.trackStock !== p.track_stock) {
      const moved = await c.query(`SELECT 1 FROM stock_movements WHERE product_id = $1 LIMIT 1`, [p.id]);
      if (moved.rows[0]) throw new HttpError(409, 'TRACKING_LOCKED', 'Stock tracking cannot be switched once the product has stock movements.');
    }
    await c.query(
      `UPDATE products SET name = $2, category = $3, price_cents = $4, cost_cents = $5, track_stock = $6, reorder_level = $7, active = $8, updated_at = now() WHERE id = $1`,
      [p.id, input.name?.trim() ?? p.name, input.category === undefined ? p.category : input.category?.trim() || null, price, cost,
       input.trackStock ?? p.track_stock, input.reorderLevel ?? p.reorder_level, input.active ?? p.active]);
    const changes: Record<string, unknown> = {};
    if (price !== p.price_cents) changes.price = { from: p.price_cents, to: price };
    if (cost !== p.cost_cents) changes.cost = { from: p.cost_cents, to: cost };
    if (input.active !== undefined && input.active !== p.active) changes.active = input.active;
    await audit(c, { actor: input.actor, role: input.role, action: changes.price ? 'product_price_changed' : 'product_updated', entityType: 'product', entityId: p.id, risk: changes.price ? 1 : 0, details: { sku: p.sku, ...changes } });
    return (await getProduct(c, p.id))!;
  });
}
