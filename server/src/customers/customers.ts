import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { audit } from '../pos/audit.js';

/** Last nine digits, so 0712 345 678, +254712345678 and 712345678 are the same customer. (Same rule orders use.) */
export const normalizePhone = (phone: string): string => String(phone).replace(/\D/g, '').slice(-9);

export interface CustomerView {
  id: number; name: string; phone: string; altPhone: string | null; town: string | null; address: string | null; notes: string | null;
  prepayRequired: boolean; prepayReason: string | null; createdAt: Date;
  stats?: { orders: number; delivered: number; returned: number; cancelled: number; active: number; lifetimeValueCents: number; lastOrderAt: Date | null };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toView = (r: any): CustomerView => ({
  id: r.id, name: r.name, phone: r.phone, altPhone: r.alt_phone, town: r.town, address: r.address, notes: r.notes,
  prepayRequired: r.prepay_required, prepayReason: r.prepay_reason, createdAt: r.created_at,
});

/** Finds the customer for a phone number or creates one, inside the caller's transaction. An existing record keeps its details. */
export async function ensureCustomer(db: Queryable, input: { name: string; phone: string; actor: string }): Promise<number> {
  const key = normalizePhone(input.phone);
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO customers (name, phone, phone_normalized, created_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (phone_normalized) DO UPDATE SET updated_at = now() RETURNING id`,
    [input.name.trim(), input.phone.trim(), key, input.actor]);
  return rows[0]!.id;
}

async function stats(db: Queryable, key: string): Promise<NonNullable<CustomerView['stats']>> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS orders,
            count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
            count(*) FILTER (WHERE status IN ('returning', 'returned'))::int AS returned,
            count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
            count(*) FILTER (WHERE status IN ('awaiting_dispatch', 'dispatched'))::int AS active,
            COALESCE(sum(total_cents) FILTER (WHERE status = 'delivered'), 0)::bigint AS ltv,
            max(created_at) AS last_at
       FROM orders WHERE phone_normalized = $1`, [key]);
  const r = rows[0]!;
  return { orders: r.orders, delivered: r.delivered, returned: r.returned, cancelled: r.cancelled, active: r.active, lifetimeValueCents: r.ltv, lastOrderAt: r.last_at };
}

export async function getCustomer(db: Queryable, id: number): Promise<CustomerView | null> {
  const { rows } = await db.query(`SELECT * FROM customers WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  return { ...toView(rows[0]), stats: await stats(db, rows[0].phone_normalized) };
}

export async function findCustomerByPhone(db: Queryable, phone: string): Promise<CustomerView | null> {
  const key = normalizePhone(phone);
  if (key.length < 7) return null;
  const { rows } = await db.query(`SELECT id FROM customers WHERE phone_normalized = $1`, [key]);
  return rows[0] ? getCustomer(db, rows[0].id) : null;
}

export async function listCustomers(db: Queryable, opts: { search?: string; prepayOnly?: boolean; limit: number; offset: number }): Promise<{ customers: CustomerView[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.search?.trim()) {
    const s = opts.search.trim();
    const digits = s.replace(/\D/g, '');
    args.push(`%${s.replace(/[%_\\]/g, '\\$&')}%`);
    const byName = `name ILIKE $${args.length}`;
    if (digits.length >= 3) { args.push(`%${digits}%`); where.push(`(${byName} OR phone_normalized LIKE $${args.length})`); } else where.push(byName);
  }
  if (opts.prepayOnly) where.push('prepay_required');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM customers ${clause}`, args)).rows[0]!.n);
  const { rows } = await db.query(`SELECT * FROM customers ${clause} ORDER BY name, id LIMIT ${opts.limit} OFFSET ${opts.offset}`, args);
  return { total, customers: rows.map(toView) };
}

export async function createCustomer(pool: Pool, input: { name: string; phone: string; altPhone?: string; town?: string; address?: string; notes?: string; actor: string; role?: string }): Promise<CustomerView> {
  if (!input.name?.trim()) throw new HttpError(422, 'CUSTOMER_NO_NAME', 'A customer needs a name.');
  const key = normalizePhone(input.phone ?? '');
  if (key.length < 7) throw new HttpError(422, 'CUSTOMER_BAD_PHONE', 'A valid phone number is required.');
  try {
    return await withTransaction(pool, async (c) => {
      const { rows } = await c.query<{ id: number }>(
        `INSERT INTO customers (name, phone, phone_normalized, alt_phone, town, address, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [input.name.trim(), input.phone.trim(), key, input.altPhone?.trim() || null, input.town?.trim() || null, input.address?.trim() || null, input.notes?.trim() || null, input.actor]);
      await audit(c, { actor: input.actor, role: input.role, action: 'customer_created', entityType: 'customer', entityId: rows[0]!.id });
      return (await getCustomer(c, rows[0]!.id))!;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'CUSTOMER_EXISTS', 'A customer with this phone number already exists.');
    throw err;
  }
}

export async function updateCustomer(pool: Pool, input: { id: number; name?: string; altPhone?: string | null; town?: string | null; address?: string | null; notes?: string | null; actor: string; role?: string }): Promise<CustomerView> {
  return withTransaction(pool, async (c) => {
    const { rows } = await c.query(`SELECT * FROM customers WHERE id = $1 FOR UPDATE`, [input.id]);
    const r = rows[0];
    if (!r) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
    if (input.name !== undefined && !input.name.trim()) throw new HttpError(422, 'CUSTOMER_NO_NAME', 'A customer needs a name.');
    const pick = (v: string | null | undefined, old: string | null) => (v === undefined ? old : v?.trim() || null);
    await c.query(`UPDATE customers SET name = $2, alt_phone = $3, town = $4, address = $5, notes = $6, updated_at = now() WHERE id = $1`,
      [r.id, input.name?.trim() ?? r.name, pick(input.altPhone, r.alt_phone), pick(input.town, r.town), pick(input.address, r.address), pick(input.notes, r.notes)]);
    await audit(c, { actor: input.actor, role: input.role, action: 'customer_updated', entityType: 'customer', entityId: r.id });
    return (await getCustomer(c, r.id))!;
  });
}

/** A customer flagged as prepay-only cannot have an order dispatched until it is paid in full. */
export async function setPrepay(pool: Pool, input: { id: number; required: boolean; reason?: string; actor: string; role?: string }): Promise<CustomerView> {
  if (input.required && !input.reason?.trim()) throw new HttpError(422, 'PREPAY_REASON_REQUIRED', 'Say why this customer must pay before dispatch.');
  return withTransaction(pool, async (c) => {
    const { rows } = await c.query(
      `UPDATE customers SET prepay_required = $2, prepay_reason = $3, updated_at = now() WHERE id = $1 RETURNING id`,
      [input.id, input.required, input.required ? input.reason!.trim() : null]);
    if (!rows[0]) throw new HttpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
    await audit(c, { actor: input.actor, role: input.role, action: input.required ? 'customer_prepay_set' : 'customer_prepay_cleared', entityType: 'customer', entityId: input.id, risk: 1, details: { reason: input.reason?.trim() ?? null } });
    return (await getCustomer(c, input.id))!;
  });
}
