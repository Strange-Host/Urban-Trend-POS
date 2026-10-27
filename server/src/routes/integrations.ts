import { Router, type Request, type RequestHandler } from 'express';
import { raiseAlert } from '../alerts/alerts.js';
import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { adaptMpesaConfirmation, CONFIRMATION_RECEIVED, TEMPORARY_FAILURE, VALIDATION_ACCEPTED } from '../integrations/mpesa.js';
import { getSecret, safeEqual } from '../integrations/secrets.js';
import { payloadKey, recordWebhookEvent } from '../integrations/webhookEvents.js';
import type { Logger } from '../logger.js';
import { ingestPaybillPayment } from '../orders/payments.js';

export interface IntegrationOpts {
  logger: Logger;
  /** SECRETS_KEY: opens the secrets kept in the database. */
  secretsKey?: string;
  /** PAYMENT_WEBHOOK_SECRET: the paybill token from the environment. Accepted beside the one in the database, so URLs already registered with Safaricom keep working. */
  webhookSecret?: string;
}

const MPESA = 'mpesa';

/** Thrown for a token that does not match: leave this router and let the rest of the API answer. */
class NotOurs extends Error {}

/**
 * Safaricom cannot send our own headers, so the shared secret is a segment of the URL it was registered with:
 *   /api/integrations/payments/callbacks/c2b/<token>/confirmation
 * A wrong token is not answered here at all: the request falls through to the rest of the API, which answers it exactly as it
 * answers any other address that needs a login. Scanning the path space therefore cannot tell a real endpoint from a miss.
 */
function mpesaTokenAuth(pool: Pool, opts: IntegrationOpts): RequestHandler {
  const check = async (req: Request): Promise<void> => {
    const provided = String(req.params.token ?? '');
    const valid: string[] = [];
    if (opts.webhookSecret) valid.push(opts.webhookSecret);
    const stored = await getSecret(pool, opts.secretsKey, MPESA, 'webhook_token');
    if (stored) valid.push(stored);
    if (valid.length === 0) opts.logger.warn('An M-Pesa callback arrived but no webhook secret is configured (PAYMENT_WEBHOOK_SECRET, or the stored mpesa/webhook_token).');
    // Every candidate is compared, with no early exit, so the time taken does not say which one matched.
    const ok = valid.map((v) => safeEqual(provided, v)).includes(true);
    if (!ok) throw new NotOurs();
  };
  return (req, _res, next) => { check(req).then(() => next(), (err: unknown) => (err instanceof NotOurs ? next('router') : next(err))); };
}

export function integrationsRouter(pool: Pool, opts: IntegrationOpts): Router {
  const r = Router();
  const auth = mpesaTokenAuth(pool, opts);
  // Safaricom is only ever told to use the neutral "c2b" spelling (its API refuses any URL containing the word "mpesa").
  // The older /mpesa/ spelling stays for anything registered by hand against the legacy system.
  const paths = (leaf: string) => [`/payments/callbacks/c2b/:token/${leaf}`, `/payments/callbacks/mpesa/:token/${leaf}`];

  r.post(paths('validation'), auth, (_req, res) => { res.json(VALIDATION_ACCEPTED); });

  r.post(paths('confirmation'), auth, (req, res, next) => {
    confirmation(req).then((out) => { res.status(out.status).json(out.body); }, next);
  });

  async function confirmation(req: Request): Promise<{ status: number; body: object }> {
    const body: unknown = req.body ?? {};
    const adapted = adaptMpesaConfirmation(body);

    // Cannot be read as a payment: keep it exactly as received, raise one alert, and tell Safaricom we have it.
    // Refusing it would only make Safaricom resend the same unreadable notice.
    const keepForReview = async (reason: string, eventKey: string) => {
      await withTransaction(pool, async (c) => {
        const isNew = await recordWebhookEvent(c, { provider: MPESA, kind: 'c2b_confirmation', eventKey, status: 'malformed', payload: body, error: reason });
        if (isNew) {
          await raiseAlert(c, { kind: 'mpesa_notice_unreadable', title: 'A paybill payment notice could not be read: a person must check it', body: { reason, eventKey } });
        }
      });
      opts.logger.error({ reason, eventKey }, 'M-Pesa confirmation could not be read; kept for review');
      return { status: 200, body: CONFIRMATION_RECEIVED };
    };

    if (!adapted.ok) return keepForReview(adapted.reason, payloadKey(body));

    try {
      const result = await ingestPaybillPayment({ pool }, adapted.notice);
      await recordWebhookEvent(pool, { provider: MPESA, kind: 'c2b_confirmation', eventKey: result.transCode, status: 'processed', payload: body, result });
      return { status: 200, body: CONFIRMATION_RECEIVED };
    } catch (err) {
      // The engine refused the notice itself (for example a malformed transaction code): a problem with the notice, not the server.
      if (err instanceof HttpError) return keepForReview(`${err.code}: ${err.message}`, payloadKey(body));
      // Anything else is ours (database down, bug). Say so, so Safaricom tries again, and keep what we can.
      opts.logger.error({ err: err instanceof Error ? err.message : String(err), transCode: adapted.notice.transCode }, 'M-Pesa confirmation failed; asking Safaricom to retry');
      await recordWebhookEvent(pool, { provider: MPESA, kind: 'c2b_confirmation', eventKey: adapted.notice.transCode.toUpperCase(), status: 'failed', payload: body, error: err instanceof Error ? err.message : String(err) }).catch(() => undefined);
      return { status: 500, body: TEMPORARY_FAILURE };
    }
  }

  return r;
}
