import { createHash } from 'node:crypto';
import type { Queryable } from '../db/tx.js';

export type WebhookStatus = 'processed' | 'malformed' | 'failed';

export interface WebhookEventInput {
  provider: string; kind: string; eventKey: string; status: WebhookStatus;
  payload: unknown; result?: unknown; error?: string;
}

/** A stable key for a notice that has no id of its own (a malformed one): the same bytes always give the same key. */
export const payloadKey = (payload: unknown): string => createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex').slice(0, 40);

/**
 * Files one notice. The unique key means the same notice arriving again changes nothing, with one exception that is the point of
 * the 'failed' status: a notice we failed to finish is overwritten by the delivery that finally succeeds. A processed or
 * malformed row is never touched again. Returns true only when a row was created or recovered, so the caller raises an alert
 * once per notice, not once per replay.
 */
export async function recordWebhookEvent(db: Queryable, e: WebhookEventInput): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO webhook_events (provider, kind, event_key, status, payload, result, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (provider, kind, event_key) DO UPDATE
       SET status = EXCLUDED.status, payload = EXCLUDED.payload, result = EXCLUDED.result, error = EXCLUDED.error, received_at = now()
       WHERE webhook_events.status = 'failed' AND EXCLUDED.status <> 'failed'`,
    [e.provider, e.kind, e.eventKey, e.status, JSON.stringify(e.payload ?? null), e.result === undefined ? null : JSON.stringify(e.result), e.error ?? null]);
  return (rowCount ?? 0) > 0;
}
