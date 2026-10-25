import type { Queryable } from '../db/tx.js';
import { shopDate } from '../payroll/time.js';
import type { CashSession } from './sessions.js';

export interface SaleSummary { id: number; saleNo: string; sessionId: number; cashier: string; status: 'completed' | 'voided'; totalCents: number; discountCents: number; createdAt: Date }

export async function listSales(db: Queryable, opts: { sessionId?: number; cashier?: string; status?: string; limit: number; offset: number }): Promise<{ sales: SaleSummary[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.sessionId) { args.push(opts.sessionId); where.push(`session_id = $${args.length}`); }
  if (opts.cashier) { args.push(opts.cashier); where.push(`cashier = $${args.length}`); }
  if (opts.status) { args.push(opts.status); where.push(`status = $${args.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM sales ${clause}`, args)).rows[0]!.n);
  const { rows } = await db.query(`SELECT * FROM sales ${clause} ORDER BY id DESC LIMIT ${opts.limit} OFFSET ${opts.offset}`, args);
  return { total, sales: rows.map((r) => ({ id: r.id, saleNo: r.sale_no, sessionId: r.session_id, cashier: r.cashier, status: r.status, totalCents: r.total_cents, discountCents: Number(r.line_discount_cents) + Number(r.sale_discount_cents), createdAt: r.created_at })) };
}

export async function listSessions(db: Queryable, opts: { status?: string; cashier?: string; needsSignoff?: boolean; limit: number; offset: number }): Promise<{ sessions: CashSession[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.status) { args.push(opts.status); where.push(`status = $${args.length}`); }
  if (opts.cashier) { args.push(opts.cashier); where.push(`cashier = $${args.length}`); }
  if (opts.needsSignoff) where.push(`signoff_required AND status = 'closed'`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM cash_sessions ${clause}`, args)).rows[0]!.n);
  const { rows } = await db.query(`SELECT * FROM cash_sessions ${clause} ORDER BY id DESC LIMIT ${opts.limit} OFFSET ${opts.offset}`, args);
  return { total, sessions: rows.map((r) => ({ id: r.id, cashier: r.cashier, openingFloatCents: r.opening_float_cents, openedAt: r.opened_at, status: r.status, closedAt: r.closed_at, varianceReason: r.variance_reason, signoffRequired: r.signoff_required, signedOffBy: r.signed_off_by })) };
}

export async function listAudit(db: Queryable, opts: { actor?: string; action?: string; minRisk?: number; entityType?: string; from?: Date; to?: Date; limit: number; offset: number }) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.actor) { args.push(opts.actor); where.push(`actor = $${args.length}`); }
  if (opts.action) { args.push(opts.action); where.push(`action = $${args.length}`); }
  if (opts.entityType) { args.push(opts.entityType); where.push(`entity_type = $${args.length}`); }
  if (opts.minRisk) { args.push(opts.minRisk); where.push(`risk >= $${args.length}`); }
  if (opts.from) { args.push(opts.from); where.push(`at >= $${args.length}`); }
  if (opts.to) { args.push(opts.to); where.push(`at < $${args.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log ${clause}`, args)).rows[0]!.n);
  const { rows } = await db.query(`SELECT id, at, actor, actor_role, action, entity_type, entity_id, amount_cents, risk, details FROM audit_log ${clause} ORDER BY id DESC LIMIT ${opts.limit} OFFSET ${opts.offset}`, args);
  return { total, entries: rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, role: r.actor_role, action: r.action, entityType: r.entity_type, entityId: r.entity_id, amountCents: r.amount_cents, risk: r.risk, details: r.details })) };
}

export async function listPolicies(db: Queryable) {
  const { rows } = await db.query(`SELECT role, free_limit_bp, approve_ceiling_bp, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, created_by FROM discount_policies ORDER BY role, effective_from DESC`);
  const today = shopDate(new Date());
  return rows.map((r) => ({ role: r.role, freeLimitBp: r.free_limit_bp, approveCeilingBp: r.approve_ceiling_bp, effectiveFrom: r.effective_from, createdBy: r.created_by, inForce: r.effective_from <= today }));
}
