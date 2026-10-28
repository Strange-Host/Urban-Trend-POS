import { Router, type Request, type RequestHandler } from 'express';
import { raiseAlert } from '../alerts/alerts.js';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { adaptKcb, kcbAck, isKcbIpnEnvelope } from '../integrations/kcb.js';
import { adaptMpesaConfirmation, adaptStkCallback, CONFIRMATION_RECEIVED, shillingsToCents, TEMPORARY_FAILURE, VALIDATION_ACCEPTED, type Adapted } from '../integrations/mpesa.js';
import { getSecret, safeEqual } from '../integrations/secrets.js';
import { noticeHandlers, type Reply } from '../integrations/notices.js';
import { payloadKey, recordWebhookEvent } from '../integrations/webhookEvents.js';
import type { Logger } from '../logger.js';
import { ingestPaybillPayment } from '../orders/payments.js';

export interface IntegrationOpts {
  logger: Logger;
  /** SECRETS_KEY: opens the secrets kept in the database. */
  secretsKey?: string;
  /** PAYMENT_WEBHOOK_SECRET: the callback token from the environment. Accepted beside the one in the database, so URLs already registered keep working. */
  webhookSecret?: string;
}

/** Thrown for a token that does not match: leave this router and let the rest of the API answer. */
class NotOurs extends Error {}

/**
 * Safaricom and KCB cannot send our own headers, so the shared secret is a segment of the URL they were registered with:
 *   /api/integrations/payments/callbacks/c2b/<token>/confirmation
 * A wrong token is not answered here at all: the request falls through to the rest of the API, which answers it exactly as it
 * answers any other address that needs a login. Scanning the path space therefore cannot tell a real endpoint from a miss.
 * Each provider has its own stored token (mpesa/webhook_token, kcb/webhook_token); the environment token is accepted for both.
 */
function tokenAuth(provider: string, pool: Pool, opts: IntegrationOpts): RequestHandler {
  const check = async (req: Request): Promise<void> => {
    const provided = String(req.params.token ?? '');
    const valid: string[] = [];
    if (opts.webhookSecret) valid.push(opts.webhookSecret);
    const stored = await getSecret(pool, opts.secretsKey, provider, 'webhook_token');
    if (stored) valid.push(stored);
    if (valid.length === 0) opts.logger.warn(`A ${provider} callback arrived but no webhook secret is configured (PAYMENT_WEBHOOK_SECRET, or the stored ${provider}/webhook_token).`);
    // Every candidate is compared, with no early exit, so the time taken does not say which one matched.
    if (!valid.map((v) => safeEqual(provided, v)).includes(true)) throw new NotOurs();
  };
  return (req, _res, next) => { check(req).then(() => next(), (err: unknown) => (err instanceof NotOurs ? next('router') : next(err))); };
}

export function integrationsRouter(pool: Pool, opts: IntegrationOpts): Router {
  const r = Router();
  const { logger } = opts;
  const mpesaAuth = tokenAuth('mpesa', pool, opts);
  const kcbAuth = tokenAuth('kcb', pool, opts);

  // ---- shared: a notice we cannot read, and a notice we could not finish ---------------------------------------------------

  const { keepForReview, askToRetry } = noticeHandlers(pool, logger);

  /** One notice that carries a payment: read it, hand it to the engine, file it. Used by M-Pesa C2B and KCB. */
  async function receivePayment(f: { provider: string; kind: string; body: unknown; adapted: Adapted; ok: Reply; retry: Reply }): Promise<Reply> {
    const base = { provider: f.provider, kind: f.kind, body: f.body };
    if (!f.adapted.ok) return keepForReview({ ...base, reason: f.adapted.reason, eventKey: payloadKey(f.body), reply: f.ok });
    try {
      const result = await ingestPaybillPayment({ pool }, f.adapted.notice);
      await recordWebhookEvent(pool, { ...base, eventKey: result.transCode, status: 'processed', payload: f.body, result });
      return f.ok;
    } catch (err) {
      // The engine refused the notice itself (for example a malformed transaction code): a problem with the notice, not the server.
      if (err instanceof HttpError) return keepForReview({ ...base, reason: `${err.code}: ${err.message}`, eventKey: payloadKey(f.body), reply: f.ok });
      return askToRetry({ ...base, eventKey: f.adapted.notice.transCode.toUpperCase(), err, reply: f.retry });
    }
  }

  const send = (p: Promise<Reply>, res: import('express').Response, next: import('express').NextFunction) => { p.then((o) => { res.status(o.status).json(o.body); }, next); };
  const ack: Reply = { status: 200, body: CONFIRMATION_RECEIVED };

  // ---- M-Pesa C2B (paybill) -------------------------------------------------------------------------------------------------
  // Safaricom is only ever told to use the neutral "c2b" spelling (its API refuses any URL containing the word "mpesa").
  // The older /mpesa/ spelling stays for anything registered by hand against the legacy system.
  const mpesaPaths = (leaf: string) => [`/payments/callbacks/c2b/:token/${leaf}`, `/payments/callbacks/mpesa/:token/${leaf}`];

  // We always accept at validation time: bouncing a customer's payment at the till is worse than recording it for a person to match.
  r.post(mpesaPaths('validation'), mpesaAuth, (_req, res) => { res.json(VALIDATION_ACCEPTED); });

  r.post(mpesaPaths('confirmation'), mpesaAuth, (req, res, next) => {
    const body: unknown = req.body ?? {};
    send(receivePayment({ provider: 'mpesa', kind: 'c2b_confirmation', body, adapted: adaptMpesaConfirmation(body), ok: ack, retry: { status: 500, body: TEMPORARY_FAILURE } }), res, next);
  });

  // ---- M-Pesa STK push result ----------------------------------------------------------------------------------------------
  r.post(mpesaPaths('stk'), mpesaAuth, (req, res, next) => {
    send(stkResult(req.body ?? {}), res, next);
  });

  async function stkResult(body: unknown): Promise<Reply> {
    const base = { provider: 'mpesa', kind: 'stk_callback', body };
    const retry: Reply = { status: 500, body: TEMPORARY_FAILURE };
    const stk = adaptStkCallback(body);
    if (!stk) return keepForReview({ ...base, reason: 'No usable stkCallback in the body.', eventKey: payloadKey(body), reply: ack });
    try {
      const { rows } = await pool.query<{ account_reference: string }>(`SELECT account_reference FROM stk_push_requests WHERE checkout_request_id = $1`, [stk.checkoutRequestId]);
      const pending = rows[0];
      // Only a push still waiting changes; a replay finds it already settled and changes nothing.
      if (pending) {
        await pool.query(`UPDATE stk_push_requests SET status = $2, result_code = $3, result_desc = $4, resolved_at = now() WHERE checkout_request_id = $1 AND status = 'pending'`,
          [stk.checkoutRequestId, stk.succeeded ? 'completed' : 'failed', stk.resultCode, stk.resultDesc ?? null]);
      }

      let result: unknown = { settled: false, resultCode: stk.resultCode }; // cancelled or timed out: no money moved
      if (stk.succeeded) {
        const amountCents = shillingsToCents(stk.amount);
        if (amountCents === null || !stk.receipt) {
          return keepForReview({ ...base, reason: 'The push succeeded but the amount or the M-Pesa receipt number is missing or unreadable.', eventKey: payloadKey(body), reply: ack });
        }
        // The receipt number is the M-Pesa transaction code, the same one the paybill confirmation carries for this payment. If both
        // arrive, the second is recognised as the first and nothing is booked twice. A push this server never sent still has real
        // money behind it: it goes to suspense for a person, rather than being dropped.
        result = await ingestPaybillPayment({ pool }, { transCode: stk.receipt, amountCents, msisdn: stk.phone, accountRef: pending?.account_reference });
      }
      const isNew = await recordWebhookEvent(pool, { provider: base.provider, kind: base.kind, payload: body, eventKey: stk.checkoutRequestId, status: 'processed', result });
      if (isNew && stk.succeeded && !pending) {
        await raiseAlert(pool, { kind: 'mpesa_stk_unknown_request', title: 'A successful STK payment arrived for a push this system did not send: it is in suspense', body: { checkoutRequestId: stk.checkoutRequestId, receipt: stk.receipt } });
      }
      return ack;
    } catch (err) {
      if (err instanceof HttpError) return keepForReview({ ...base, reason: `${err.code}: ${err.message}`, eventKey: payloadKey(body), reply: ack });
      return askToRetry({ ...base, eventKey: stk.checkoutRequestId, err, reply: retry });
    }
  }

  // ---- KCB Buni IPN -----------------------------------------------------------------------------------------------------------
  r.post('/payments/callbacks/kcb/:token/callback', kcbAuth, (req, res, next) => {
    const body: unknown = req.body ?? {};
    const envelope = isKcbIpnEnvelope(body);
    // KCB gets its own acknowledgement envelope; any other body keeps the older flat reply, as in the legacy system.
    const ok: Reply = envelope ? { status: 200, body: kcbAck(body) } : { status: 201, body: { status: 'received' } };
    const retry: Reply = { status: 500, body: envelope ? kcbAck(body, false) : { status: 'retry' } };
    send(receivePayment({ provider: 'kcb', kind: 'ipn', body, adapted: adaptKcb(body), ok, retry }), res, next);
  });

  return r;
}
