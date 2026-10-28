import { raiseAlert } from '../alerts/alerts.js';
import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import type { Logger } from '../logger.js';
import { recordWebhookEvent } from './webhookEvents.js';

export type Reply = { status: number; body: object };

/**
 * The two ways a notice from an outside system can go wrong, handled the same for every provider.
 *  - keepForReview: it cannot be used as it stands (unreadable, refused as invalid, or needs a person's decision). Keep it exactly as
 *    received, raise one alert, and tell the sender we have it, so it does not resend the same thing forever.
 *  - askToRetry: the fault is ours (database down, a bug). Say so, so the sender tries again, and keep what we can.
 */
export function noticeHandlers(pool: Pool, logger: Logger) {
  async function keepForReview(f: { provider: string; kind: string; body: unknown; reason: string; eventKey: string; reply: Reply; alertTitle?: string }): Promise<Reply> {
    await withTransaction(pool, async (c) => {
      const isNew = await recordWebhookEvent(c, { provider: f.provider, kind: f.kind, eventKey: f.eventKey, status: 'malformed', payload: f.body, error: f.reason });
      if (isNew) await raiseAlert(c, { kind: `${f.provider}_notice_unreadable`, title: f.alertTitle ?? `A ${f.provider.toUpperCase()} notice could not be used: a person must check it`, body: { reason: f.reason, eventKey: f.eventKey, kind: f.kind } });
    });
    logger.error({ provider: f.provider, kind: f.kind, reason: f.reason, eventKey: f.eventKey }, 'notice could not be used; kept for review');
    return f.reply;
  }

  async function askToRetry(f: { provider: string; kind: string; body: unknown; eventKey: string; err: unknown; reply: Reply }): Promise<Reply> {
    const message = f.err instanceof Error ? f.err.message : String(f.err);
    logger.error({ err: message, provider: f.provider, kind: f.kind, eventKey: f.eventKey }, 'notice failed; asking the sender to retry');
    await recordWebhookEvent(pool, { provider: f.provider, kind: f.kind, eventKey: f.eventKey, status: 'failed', payload: f.body, error: message }).catch(() => undefined);
    return f.reply;
  }

  return { keepForReview, askToRetry };
}
