import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { ensureCustomer, normalizePhone } from '../customers/customers.js';
import { createOrderTx, prepareOrder, type OrderItemInput, type OrderView } from '../orders/orders.js';
import { audit } from '../pos/audit.js';

export const LEAD_SOURCES = ['manual', 'whatsapp', 'website', 'phone', 'walk_in', 'shopify', 'other'] as const;
export const OPEN_STATUSES = ['new', 'contacted', 'qualified'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'converted' | 'lost';
export type Direction = 'inbound' | 'outbound' | 'note';
export type Channel = 'whatsapp' | 'sms' | 'call' | 'website' | 'internal';

export interface LeadView {
  id: number; name: string | null; phone: string; source: LeadSource; productInterest: string | null; notes: string | null;
  status: LeadStatus; assignedTo: string | null; lostReason: string | null; convertedOrderRef: string | null; convertedAt: Date | null;
  createdBy: string; createdAt: Date; updatedAt: Date;
  messages?: { id: number; direction: Direction; channel: Channel; body: string; actor: string; at: Date }[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toView = (r: any): LeadView => ({
  id: r.id, name: r.name, phone: r.phone, source: r.source, productInterest: r.product_interest, notes: r.notes, status: r.status, assignedTo: r.assigned_to,
  lostReason: r.lost_reason, convertedOrderRef: r.converted_order_ref, convertedAt: r.converted_at, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});

export async function getLead(db: Queryable, id: number): Promise<LeadView | null> {
  const { rows } = await db.query(`SELECT * FROM leads WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  const msgs = await db.query(`SELECT id, direction, channel, body, actor, at FROM lead_messages WHERE lead_id = $1 ORDER BY id`, [id]);
  return { ...toView(rows[0]), messages: msgs.rows };
}

export async function listLeads(db: Queryable, opts: { status?: LeadStatus | 'open'; assignedTo?: string; unassigned?: boolean; source?: string; search?: string; limit: number; offset: number }): Promise<{ leads: LeadView[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status === 'open') where.push(`status IN ('new', 'contacted', 'qualified')`);
  else if (opts.status) { args.push(opts.status); where.push(`status = $${args.length}`); }
  if (opts.assignedTo) { args.push(opts.assignedTo); where.push(`assigned_to = $${args.length}`); }
  if (opts.unassigned) where.push('assigned_to IS NULL');
  if (opts.source) { args.push(opts.source); where.push(`source = $${args.length}`); }
  if (opts.search?.trim()) {
    const s = opts.search.trim();
    args.push(`%${s.replace(/[%_\\]/g, '\\$&')}%`);
    const base = `(name ILIKE $${args.length} OR product_interest ILIKE $${args.length}`;
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 3) { args.push(`%${digits}%`); where.push(`${base} OR phone_normalized LIKE $${args.length})`); } else where.push(`${base})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM leads ${clause}`, args)).rows[0]!.n);
  const { rows } = await db.query(`SELECT * FROM leads ${clause} ORDER BY created_at DESC, id DESC LIMIT ${opts.limit} OFFSET ${opts.offset}`, args);
  return { total, leads: rows.map(toView) };
}

/**
 * Records a new enquiry. If the same phone number already has an open lead, nothing is duplicated: the message is added to the
 * existing lead and that lead is returned with `duplicate: true`.
 */
export async function createLead(pool: Pool, input: {
  name?: string; phone: string; source?: LeadSource; productInterest?: string; notes?: string; message?: string; channel?: Channel; assignedTo?: string; actor: string; role?: string;
}): Promise<{ lead: LeadView; duplicate: boolean }> {
  const key = normalizePhone(input.phone ?? '');
  if (key.length < 7) throw new HttpError(422, 'LEAD_BAD_PHONE', 'A valid phone number is required.');
  const source = input.source ?? 'manual';
  if (!LEAD_SOURCES.includes(source)) throw new HttpError(422, 'LEAD_BAD_SOURCE', `A source is one of: ${LEAD_SOURCES.join(', ')}.`);
  return withTransaction(pool, async (c) => {
    const open = await c.query<{ id: number }>(`SELECT id FROM leads WHERE phone_normalized = $1 AND status IN ('new', 'contacted', 'qualified') FOR UPDATE`, [key]);
    if (open.rows[0]) {
      if (input.message?.trim()) {
        await c.query(`INSERT INTO lead_messages (lead_id, direction, channel, body, actor) VALUES ($1, 'inbound', $2, $3, $4)`, [open.rows[0].id, input.channel ?? 'internal', input.message.trim(), input.actor]);
        await c.query(`UPDATE leads SET updated_at = now() WHERE id = $1`, [open.rows[0].id]);
      }
      return { lead: (await getLead(c, open.rows[0].id))!, duplicate: true };
    }
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO leads (name, phone, phone_normalized, source, product_interest, notes, assigned_to, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [input.name?.trim() || null, input.phone.trim(), key, source, input.productInterest?.trim() || null, input.notes?.trim() || null, input.assignedTo?.trim() || null, input.actor]);
    if (input.message?.trim()) {
      await c.query(`INSERT INTO lead_messages (lead_id, direction, channel, body, actor) VALUES ($1, 'inbound', $2, $3, $4)`, [rows[0]!.id, input.channel ?? 'internal', input.message.trim(), input.actor]);
    }
    await audit(c, { actor: input.actor, role: input.role, action: 'lead_created', entityType: 'lead', entityId: rows[0]!.id, details: { source } });
    return { lead: (await getLead(c, rows[0]!.id))!, duplicate: false };
  });
}

async function lockLead(c: Queryable, id: number) {
  const { rows } = await c.query(`SELECT * FROM leads WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw new HttpError(404, 'LEAD_NOT_FOUND', 'Lead not found.');
  return rows[0] as { id: number; status: LeadStatus; name: string | null; phone: string; assigned_to: string | null };
}
const mustBeOpen = (l: { status: LeadStatus }) => {
  if (l.status === 'converted') throw new HttpError(409, 'LEAD_CONVERTED', 'This lead has already become an order.');
};

export async function updateLead(pool: Pool, input: { id: number; name?: string | null; productInterest?: string | null; notes?: string | null; actor: string }): Promise<LeadView> {
  return withTransaction(pool, async (c) => {
    const l = await lockLead(c, input.id);
    mustBeOpen(l);
    const pick = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);
    await c.query(
      `UPDATE leads SET name = CASE WHEN $2::boolean THEN $3 ELSE name END, product_interest = CASE WHEN $4::boolean THEN $5 ELSE product_interest END,
              notes = CASE WHEN $6::boolean THEN $7 ELSE notes END, updated_at = now() WHERE id = $1`,
      [l.id, input.name !== undefined, pick(input.name) ?? null, input.productInterest !== undefined, pick(input.productInterest) ?? null, input.notes !== undefined, pick(input.notes) ?? null]);
    return (await getLead(c, l.id))!;
  });
}

const RANK: Record<string, number> = { new: 0, contacted: 1, qualified: 2 };

/** Moves a lead along (new, contacted, qualified), marks it lost (with a reason), or reopens a lost one. Converting is its own action. */
export async function setLeadStatus(pool: Pool, input: { id: number; status: 'new' | 'contacted' | 'qualified' | 'lost'; lostReason?: string; actor: string; role?: string }): Promise<LeadView> {
  if (input.status === 'lost' && !input.lostReason?.trim()) throw new HttpError(422, 'LEAD_LOST_REASON_REQUIRED', 'Say why this lead was lost.');
  return withTransaction(pool, async (c) => {
    const l = await lockLead(c, input.id);
    mustBeOpen(l);
    if (input.status !== 'lost' && l.status !== 'lost' && RANK[input.status]! < RANK[l.status]!) throw new HttpError(409, 'LEAD_STATUS_BACKWARDS', `A ${l.status} lead cannot go back to ${input.status}.`);
    try {
      await c.query(`UPDATE leads SET status = $2, lost_reason = $3, updated_at = now() WHERE id = $1`, [l.id, input.status, input.status === 'lost' ? input.lostReason!.trim() : null]);
    } catch (err) {
      // Reopening a lost lead while the same phone already has another open one.
      if ((err as { constraint?: string }).constraint === 'leads_one_open_per_phone') throw new HttpError(409, 'LEAD_PHONE_HAS_OPEN_LEAD', 'This phone number already has another open lead.');
      throw err;
    }
    await audit(c, { actor: input.actor, role: input.role, action: 'lead_status_changed', entityType: 'lead', entityId: l.id, details: { from: l.status, to: input.status, reason: input.lostReason?.trim() ?? null } });
    return (await getLead(c, l.id))!;
  });
}

export async function assignLead(pool: Pool, input: { id: number; assignedTo: string | null; actor: string; role?: string }): Promise<LeadView> {
  return withTransaction(pool, async (c) => {
    const l = await lockLead(c, input.id);
    mustBeOpen(l);
    const to = input.assignedTo?.trim() || null;
    if (to) {
      const u = await c.query(`SELECT 1 FROM users WHERE username = $1 AND active`, [to.toLowerCase()]);
      if (!u.rows[0]) throw new HttpError(422, 'LEAD_ASSIGNEE_UNKNOWN', `${to} is not an active user.`);
    }
    await c.query(`UPDATE leads SET assigned_to = $2, updated_at = now() WHERE id = $1`, [l.id, to?.toLowerCase() ?? null]);
    await audit(c, { actor: input.actor, role: input.role, action: 'lead_assigned', entityType: 'lead', entityId: l.id, details: { from: l.assigned_to, to } });
    return (await getLead(c, l.id))!;
  });
}

export async function addLeadMessage(pool: Pool, input: { id: number; direction: Direction; channel?: Channel; body: string; actor: string }): Promise<LeadView> {
  if (!['inbound', 'outbound', 'note'].includes(input.direction)) throw new HttpError(422, 'LEAD_BAD_DIRECTION', 'A message is inbound, outbound or a note.');
  if (!input.body?.trim()) throw new HttpError(422, 'LEAD_EMPTY_MESSAGE', 'A message cannot be empty.');
  return withTransaction(pool, async (c) => {
    const l = await lockLead(c, input.id);
    await c.query(`INSERT INTO lead_messages (lead_id, direction, channel, body, actor) VALUES ($1, $2, $3, $4, $5)`, [l.id, input.direction, input.channel ?? 'internal', input.body.trim(), input.actor]);
    await c.query(`UPDATE leads SET updated_at = now() WHERE id = $1`, [l.id]);
    return (await getLead(c, l.id))!;
  });
}

/**
 * Turns a lead into an order. One transaction: the order is created (stock checked, one-active-order-per-phone enforced, the
 * amount owed booked to the ledger) AND the lead is marked converted with the order's reference. If anything fails, neither happens,
 * and a lead can only ever be converted once.
 */
export async function convertLead(pool: Pool, refKey: string, input: {
  id: number; items: OrderItemInput[]; customerName?: string; discountCents?: number; notes?: string; assignedTo?: string; actor: string; role?: string;
}): Promise<{ lead: LeadView; order: OrderView }> {
  return withTransaction(pool, async (c) => {
    const l = await lockLead(c, input.id);
    mustBeOpen(l);
    if (l.status === 'lost') throw new HttpError(409, 'LEAD_LOST', 'This lead was marked lost. Reopen it before converting.');
    const name = input.customerName?.trim() || l.name?.trim();
    if (!name) throw new HttpError(422, 'LEAD_NEEDS_NAME', 'Give the customer\'s name: the lead has none.');
    const create = { customerName: name, customerPhone: l.phone, items: input.items, discountCents: input.discountCents, notes: input.notes, assignedTo: input.assignedTo ?? l.assigned_to ?? undefined, actor: input.actor };
    const order = await createOrderTx(c, refKey, create, prepareOrder(create));
    await ensureCustomer(c, { name, phone: l.phone, actor: input.actor });
    await c.query(`UPDATE leads SET status = 'converted', converted_order_ref = $2, converted_at = now(), name = COALESCE(name, $3), updated_at = now() WHERE id = $1`, [l.id, order.orderRef, name]);
    await audit(c, { actor: input.actor, role: input.role, action: 'lead_converted', entityType: 'lead', entityId: l.id, amountCents: order.totalCents, details: { order_ref: order.orderRef } });
    return { lead: (await getLead(c, l.id))!, order };
  });
}
