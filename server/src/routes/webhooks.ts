import express, { Router, type Request } from 'express';
import { raiseAlert } from '../alerts/alerts.js';
import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { noticeHandlers, type Reply } from '../integrations/notices.js';
import { importOnlineOrder, platformLabel, type ImportOutcome } from '../integrations/onlineOrders.js';
import { getSource, verifyDelivery, type Platform } from '../integrations/sources.js';
import { payloadKey, recordWebhookEvent } from '../integrations/webhookEvents.js';
import type { Logger } from '../logger.js';

export interface WebhookOpts { logger: Logger; secretsKey?: string; refKey: string }

type Raw = Request & { rawBody?: Buffer };
const header = (req: Request, name: string): string => { const v = req.headers[name]; return (Array.isArray(v) ? v[0] : v) ?? ''; };

/**
 * Deliveries from Shopify and WooCommerce. The address ends in the connection's id, the same as in the legacy system, so webhooks
 * already registered with the stores keep working after cutover. Nobody is logged in here: the store proves itself by signing the
 * exact bytes it sends with a secret only it and we know.
 *
 * Mounted BEFORE the API-wide JSON parser: it needs the raw bytes for the signature, allows larger bodies than the rest of the API
 * (a store sends whole orders and products), and must also read the form-encoded ping WooCommerce sends when a webhook is created.
 */
export function webhooksRouter(pool: Pool, opts: WebhookOpts): Router {
  const r = Router();
  const { logger } = opts;
  const { keepForReview, askToRetry } = noticeHandlers(pool, logger);
  const keep = (req: Raw, _res: unknown, buf: Buffer) => { req.rawBody = buf; };
  r.use(express.json({ limit: '10mb', verify: keep as never }));
  r.use(express.urlencoded({ extended: false, limit: '1mb', verify: keep as never }));

  const refused: Reply = { status: 401, body: { error: 'Invalid signature.' } };
  // Once a delivery is proven genuine we answer 200 for anything that is a problem with the DATA (it is kept for a person), because a
  // store that keeps getting errors eventually deletes its subscription, which would end live sync silently. Only a fault of ours is a 500.
  const ok = (status: string): Reply => ({ status: 200, body: { status } });

  async function receive(platform: Platform, req: Raw): Promise<Reply> {
    const source = await getSource(pool, Number(req.params.sourceId));
    // An unknown connection and a bad signature look the same from outside, so ids cannot be probed.
    if (!source || source.platform !== platform) return refused;
    const body: unknown = req.body ?? {};
    const b = body as Record<string, unknown>;

    // WooCommerce sends an unsigned form-encoded "ping" when a webhook is created. It only wants a 200 and carries nothing.
    if (platform === 'woocommerce' && !header(req, 'x-wc-webhook-signature') && b.webhook_id && !b.id) return ok('pong');

    const verdict = await verifyDelivery(pool, opts.secretsKey, source, req.headers, req.rawBody);
    if (!verdict.ok) { logger.warn({ source: source.id, platform, why: verdict.why }, 'webhook refused'); return refused; }

    const topic = header(req, platform === 'shopify' ? 'x-shopify-topic' : 'x-wc-webhook-topic');
    if (!topic) return ok('ignored');
    if (!source.isActive || !source.liveSyncEnabled) return ok('ignored');

    const delivery = header(req, platform === 'shopify' ? 'x-shopify-webhook-id' : 'x-wc-webhook-delivery-id') || header(req, platform === 'shopify' ? 'x-shopify-event-id' : 'x-wc-webhook-id');
    const eventKey = `${source.id}:${delivery || payloadKey(body)}`;
    const base = { provider: platform, kind: topic, body };

    // The store sent this very delivery before and we dealt with it (or put it aside for a person): nothing to do, nothing to change.
    const seen = await pool.query<{ status: string }>(`SELECT status FROM webhook_events WHERE provider = $1 AND kind = $2 AND event_key = $3`, [platform, topic, eventKey]);
    if (seen.rows[0] && seen.rows[0].status !== 'failed') return ok('duplicate');

    const [resource, action] = platform === 'shopify' ? topic.split('/') : topic.split('.');
    try {
      let outcome: ImportOutcome | { action: 'ignored'; reason: string };
      if (resource === 'orders' || resource === 'order') {
        outcome = await importOnlineOrder({ pool, refKey: opts.refKey }, source, b, { deleted: action === 'deleted' });
      } else if (resource === 'products' || resource === 'product') {
        // The catalogue half of live sync (staging products for review) arrives with the Catalog page; until then it is acknowledged only.
        outcome = { action: 'ignored', reason: 'Product changes are not handled by the new server yet.' };
      } else {
        outcome = { action: 'ignored', reason: `Not a topic we use: ${topic}` };
      }

      await withTransaction(pool, async (c) => {
        const isNew = await recordWebhookEvent(c, { provider: platform, kind: topic, eventKey, status: 'processed', payload: body, result: outcome });
        if (!isNew) return; // a copy delivered at the same moment got here first
        await c.query(`UPDATE income_sources SET last_webhook_at = now() WHERE id = $1`, [source.id]);
        const label = platformLabel(platform);
        if (outcome.action === 'created' && outcome.paidOnline) {
          await raiseAlert(c, { kind: 'online_order_paid_online', title: `${label} order imported as already paid online: record its payment before dispatch`, body: { orderRef: outcome.orderRef, eventKey } });
        } else if (outcome.action === 'needs_attention') {
          await raiseAlert(c, { kind: 'online_order_needs_attention', title: `${label} order needs a person: ${outcome.orderRef}`, body: { orderRef: outcome.orderRef, reason: outcome.reason } });
        }
      });
      return ok(outcome.action === 'ignored' || outcome.action === 'unchanged' ? 'ignored' : 'processed');
    } catch (err) {
      if (err instanceof HttpError) {
        return keepForReview({ ...base, eventKey, reason: `${err.code}: ${err.message}`, reply: ok('needs_review'), alertTitle: `A ${platformLabel(platform)} order could not be imported: a person must check it` });
      }
      return askToRetry({ ...base, eventKey, err, reply: { status: 500, body: { status: 'retry' } } });
    }
  }

  const route = (platform: Platform) => (req: Request, res: express.Response, next: express.NextFunction) => {
    receive(platform, req as Raw).then((out) => { res.status(out.status).json(out.body); }, next);
  };
  r.post('/shopify/:sourceId', route('shopify'));
  r.post('/woocommerce/:sourceId', route('woocommerce'));
  return r;
}
