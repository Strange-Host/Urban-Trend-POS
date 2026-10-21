import type { Queryable } from '../db/tx.js';

// Every checkout, discount, void, refund and cash movement writes an audit row in the SAME transaction as the action itself,
// so an action and its record stand or fall together: there is no way to do one without the other.
export interface AuditEvent {
  actor: string;
  role?: string;
  action: string;
  entityType: string;
  entityId?: string | number;
  amountCents?: number;
  /** 0 routine, 1 notable, 2 risky. Feeds the risky-actions report. */
  risk?: 0 | 1 | 2;
  details?: Record<string, unknown>;
}

export async function audit(db: Queryable, e: AuditEvent): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor, actor_role, action, entity_type, entity_id, amount_cents, risk, details) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.actor, e.role ?? null, e.action, e.entityType, e.entityId === undefined ? null : String(e.entityId), e.amountCents ?? null, e.risk ?? 0, JSON.stringify(e.details ?? {})]);
}
