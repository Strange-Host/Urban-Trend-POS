import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { audit } from '../pos/audit.js';

export interface AlertView { id: number; kind: string; severity: 'info' | 'high'; title: string; body: Record<string, unknown>; createdAt: Date; acknowledgedBy: string | null; acknowledgedAt: Date | null; note: string | null }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toView = (r: any): AlertView => ({ id: r.id, kind: r.kind, severity: r.severity, title: r.title, body: r.body, createdAt: r.created_at, acknowledgedBy: r.acknowledged_by, acknowledgedAt: r.acknowledged_at, note: r.note });

/** Raises an alert unless one of the same kind is already open. Returns the new alert, or null if one was already open. */
export async function raiseAlert(db: Queryable, input: { kind: string; severity?: 'info' | 'high'; title: string; body?: Record<string, unknown> }): Promise<AlertView | null> {
  const { rows } = await db.query(
    `INSERT INTO alerts (kind, severity, title, body) VALUES ($1, $2, $3, $4) ON CONFLICT (kind) WHERE acknowledged_at IS NULL DO NOTHING RETURNING *`,
    [input.kind, input.severity ?? 'high', input.title, JSON.stringify(input.body ?? {})]);
  return rows[0] ? toView(rows[0]) : null;
}

export async function listAlerts(db: Queryable, opts: { openOnly?: boolean; limit: number; offset: number }): Promise<{ alerts: AlertView[]; total: number; openCount: number }> {
  const where = opts.openOnly ? 'WHERE acknowledged_at IS NULL' : '';
  const total = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM alerts ${where}`)).rows[0]!.n);
  const open = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM alerts WHERE acknowledged_at IS NULL`)).rows[0]!.n);
  const { rows } = await db.query(`SELECT * FROM alerts ${where} ORDER BY id DESC LIMIT ${opts.limit} OFFSET ${opts.offset}`);
  return { total, openCount: open, alerts: rows.map(toView) };
}

export async function acknowledgeAlert(pool: Pool, input: { id: number; note?: string; actor: string; role?: string }): Promise<AlertView> {
  return withTransaction(pool, async (c) => {
    const found = await c.query(`SELECT * FROM alerts WHERE id = $1 FOR UPDATE`, [input.id]);
    if (!found.rows[0]) throw new HttpError(404, 'ALERT_NOT_FOUND', 'Alert not found.');
    if (found.rows[0].acknowledged_at) throw new HttpError(409, 'ALERT_ALREADY_ACKNOWLEDGED', 'This alert has already been acknowledged.');
    const { rows } = await c.query(`UPDATE alerts SET acknowledged_by = $2, acknowledged_at = now(), note = $3 WHERE id = $1 RETURNING *`, [input.id, input.actor, input.note?.trim() || null]);
    await audit(c, { actor: input.actor, role: input.role, action: 'alert_acknowledged', entityType: 'alert', entityId: input.id, risk: 1, details: { kind: rows[0].kind } });
    return toView(rows[0]);
  });
}
