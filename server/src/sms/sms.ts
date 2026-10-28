import { getSecret, putSecret } from '../integrations/secrets.js';
import { raiseAlert } from '../alerts/alerts.js';
import type { Pool } from '../db/pool.js';
import { withTransaction, type Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { accountBalance } from '../ledger/ledger.js';
import type { Logger } from '../logger.js';
import { maskPhone, toMsisdn } from './phone.js';
import { orderReceived, paymentReceived, type SmsSettings } from './templates.js';
import { DEFAULT_SEND_URL, sendSms, type SmsCredentials } from './zettatel.js';

export interface SmsCtx {
  pool: Pool; logger: Logger;
  /** SECRETS_KEY: opens the stored Zettatel credentials. */
  secretsKey?: string;
  /** The gateway credentials from the environment, used when none are stored (for deployments that keep secrets out of the database). */
  envCredentials?: { userId?: string; password?: string; senderId?: string };
  sendUrl?: string;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

// The settings use the legacy key names, so the Settings pages port without translation.
const DEFAULTS: SmsSettings = {
  sms_enabled: '0', sms_send_order_received: '1', sms_send_payment_received: '1', sms_message_type: 'unicode',
  sms_delivery_promise: 'It will be delivered within the next 24 hours.', sms_catalog_url: '', sms_sender_id: '',
  business_name: 'Urban Trends', paybill_number: '', kcb_account_prefix: '',
};

/** Read inside the caller's transaction, so a message is worded from the settings that were true when the order was made. */
export async function smsSettings(db: Queryable): Promise<SmsSettings> {
  const { rows } = await db.query<{ key: string; value: string }>(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [Object.keys(DEFAULTS)]);
  return { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

const PROVIDER = 'zettatel';

// ---- credentials ------------------------------------------------------------------------------------------------------------------
export interface RawCredentials extends SmsCredentials { source: 'database' | 'environment' }

export async function getRawCredentials(ctx: Pick<SmsCtx, 'pool' | 'secretsKey' | 'envCredentials'>, db: Queryable = ctx.pool): Promise<RawCredentials | null> {
  const s = await smsSettings(db);
  const msgType = s.sms_message_type === 'text' ? 'text' : 'unicode';
  const userId = await getSecret(db, ctx.secretsKey, PROVIDER, 'user_id');
  const password = await getSecret(db, ctx.secretsKey, PROVIDER, 'password');
  if (userId && password) return { userId, password, senderId: s.sms_sender_id ?? '', msgType, source: 'database' };
  const e = ctx.envCredentials;
  if (e?.userId && e.password) return { userId: e.userId, password: e.password, senderId: e.senderId ?? '', msgType, source: 'environment' };
  return null;
}

/** Whether things are set, never the values. */
export async function getSafeCredentials(ctx: Pick<SmsCtx, 'pool' | 'secretsKey' | 'envCredentials'>) {
  const { rows } = await ctx.pool.query<{ name: string }>(`SELECT name FROM integration_secrets WHERE provider = $1`, [PROVIDER]);
  const raw = await getRawCredentials(ctx).catch(() => null);
  return { configured: Boolean(raw), source: raw?.source ?? null, hasUserId: rows.some((r) => r.name === 'user_id'), hasPassword: rows.some((r) => r.name === 'password'), senderId: (await smsSettings(ctx.pool)).sms_sender_id };
}

export async function saveCredentials(ctx: Pick<SmsCtx, 'pool' | 'secretsKey' | 'envCredentials'>, input: { userId?: string; password?: string; senderId?: string; actor: string }) {
  await withTransaction(ctx.pool, async (c) => {
    const had = (await c.query<{ name: string }>(`SELECT name FROM integration_secrets WHERE provider = $1`, [PROVIDER])).rows.map((r) => r.name);
    const userId = input.userId?.trim(); const password = input.password;
    if ((!userId && !had.includes('user_id')) || (!password && !had.includes('password'))) {
      throw new HttpError(422, 'SMS_CREDENTIALS_INCOMPLETE', 'Both the Zettatel user ID and password are needed the first time you save credentials.');
    }
    if (userId) await putSecret(c, ctx.secretsKey, { provider: PROVIDER, name: 'user_id', value: userId, actor: input.actor });
    if (password) await putSecret(c, ctx.secretsKey, { provider: PROVIDER, name: 'password', value: password, actor: input.actor });
    if (input.senderId !== undefined) {
      await c.query(`INSERT INTO app_settings (key, value, updated_by) VALUES ('sms_sender_id', $1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [input.senderId.trim(), input.actor]);
    }
  });
  return getSafeCredentials(ctx);
}

export async function removeCredentials(ctx: Pick<SmsCtx, 'pool' | 'secretsKey' | 'envCredentials'>) {
  await ctx.pool.query(`DELETE FROM integration_secrets WHERE provider = $1`, [PROVIDER]);
  return getSafeCredentials(ctx);
}

// ---- queueing -----------------------------------------------------------------------------------------------------------------------
export type Queued = { queued: true; id: number } | { queued: false; reason: 'invalid_phone' | 'duplicate' | 'disabled' | 'error' };

/**
 * Queues one message. Just an INSERT: inside the caller's transaction, so if that rolls back the message goes with it. The dedupe key
 * makes queueing the same event twice a quiet no-op, which is what stops a redelivered payment notice from texting a customer twice.
 */
export async function enqueue(db: Queryable, m: { toPhone: string; template: string; body: string; relatedType?: string; relatedId?: string | number; dedupeKey?: string }): Promise<Queued> {
  const msisdn = toMsisdn(m.toPhone);
  if (!msisdn) return { queued: false, reason: 'invalid_phone' };
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sms_outbox (to_phone, template, body, related_type, related_id, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
    [msisdn, m.template, m.body, m.relatedType ?? null, m.relatedId === undefined ? null : String(m.relatedId), m.dedupeKey ?? null]);
  return rows[0] ? { queued: true, id: Number(rows[0].id) } : { queued: false, reason: 'duplicate' };
}

// A pool counts its connections; a single client (which also has a connect method, so that is no way to tell) does not.
const isPool = (db: Queryable): db is Pool => typeof (db as Pool).totalCount === 'number';

/**
 * Runs a hook with a savepoint around it. A messaging problem must never be the reason an order or a payment fails to save, and in
 * PostgreSQL a failed statement poisons the whole transaction unless it is rolled back to a known point. (Handed a plain pool rather
 * than a transaction, it opens a small one of its own, so a savepoint always has a transaction to live in.)
 */
async function safely(db: Queryable, what: string, fn: (d: Queryable) => Promise<Queued>): Promise<Queued> {
  if (isPool(db)) return withTransaction(db, (c) => safely(c, what, fn));
  await db.query('SAVEPOINT sms_hook');
  try { const r = await fn(db); await db.query('RELEASE SAVEPOINT sms_hook'); return r; }
  catch (err) { await db.query('ROLLBACK TO SAVEPOINT sms_hook'); await db.query('RELEASE SAVEPOINT sms_hook'); console.error(`[sms] could not queue ${what}: ${err instanceof Error ? err.message : String(err)}`); return { queued: false, reason: 'error' }; }
}

export function queueOrderReceived(db: Queryable, o: { orderRef: string; customerName: string; customerPhone: string; itemNames: string[] }): Promise<Queued> {
  return safely(db, 'order_received', async (d) => {
    const s = await smsSettings(d);
    if (s.sms_enabled !== '1' || s.sms_send_order_received !== '1') return { queued: false, reason: 'disabled' };
    return enqueue(d, { toPhone: o.customerPhone, template: 'order_received', body: orderReceived({ settings: s, customerName: o.customerName, itemNames: o.itemNames, orderRef: o.orderRef }), relatedType: 'order', relatedId: o.orderRef, dedupeKey: `order_received:${o.orderRef}` });
  });
}

/** Called right after a receipt is issued, in the same transaction, so the balance told to the customer is the one the ledger now shows. */
export function queuePaymentReceived(db: Queryable, p: { receiptId: number; orderRef: string; amountCents: number }): Promise<Queued> {
  return safely(db, 'payment_received', async (d) => {
    const s = await smsSettings(d);
    if (s.sms_enabled !== '1' || s.sms_send_payment_received !== '1') return { queued: false, reason: 'disabled' };
    const o = (await d.query<{ customer_name: string; customer_phone: string }>(`SELECT customer_name, customer_phone FROM orders WHERE order_ref = $1`, [p.orderRef])).rows[0];
    if (!o) return { queued: false, reason: 'error' };
    const balanceCents = Math.max(await accountBalance(d, 'CUSTOMER_RECEIVABLE', { orderRef: p.orderRef }), 0);
    return enqueue(d, { toPhone: o.customer_phone, template: 'payment_received', body: paymentReceived({ settings: s, customerName: o.customer_name, orderRef: p.orderRef, amountCents: p.amountCents, balanceCents }), relatedType: 'receipt', relatedId: p.receiptId, dedupeKey: `payment_received:${p.receiptId}` });
  });
}

// ---- the worker ----------------------------------------------------------------------------------------------------------------------
export const MAX_ATTEMPTS = 5;
const BACKOFF_MINUTES = [1, 5, 15, 60];   // the wait before attempt 2, 3, 4, 5
const STALE_AFTER_HOURS = 24;
const STUCK_SENDING_MINUTES = 10;
const BATCH = 20;
const backoffFor = (attemptsSoFar: number) => BACKOFF_MINUTES[Math.min(attemptsSoFar - 1, BACKOFF_MINUTES.length - 1)]!;

export interface OutboxSummary { sent: number; retried: number; failed: number; expired: number; waitingForCredentials: number }

/**
 * Sends what is due. Safe to run on a timer and from every instance: a message is claimed (queued -> sending) by one worker only, a
 * message stuck in 'sending' after a crash is put back, and anything older than 24 hours is dropped, never delivered late. With no
 * credentials, messages simply wait (and a failed send is never counted as an attempt against them).
 */
export async function processOutbox(ctx: SmsCtx): Promise<OutboxSummary> {
  const { pool, logger } = ctx; const f = ctx.fetch ?? fetch;
  const summary: OutboxSummary = { sent: 0, retried: 0, failed: 0, expired: 0, waitingForCredentials: 0 };

  await pool.query(`UPDATE sms_outbox SET status = 'queued', updated_at = now() WHERE status = 'sending' AND updated_at < now() - make_interval(mins => $1)`, [STUCK_SENDING_MINUTES]);
  summary.expired = (await pool.query(
    `UPDATE sms_outbox SET status = 'expired', last_error = $2, updated_at = now() WHERE status = 'queued' AND created_at < now() - make_interval(hours => $1)`,
    [STALE_AFTER_HOURS, `Not sent within ${STALE_AFTER_HOURS}h: dropped so a stale message is never delivered late.`])).rowCount ?? 0;

  const creds = await getRawCredentials(ctx);
  if (!creds) {
    summary.waitingForCredentials = Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM sms_outbox WHERE status = 'queued' AND next_attempt_at <= now()`)).rows[0]!.n);
    if (summary.waitingForCredentials > 0) logger.warn({ waiting: summary.waitingForCredentials }, 'SMS messages are queued but no Zettatel credentials are set');
    return summary;
  }

  const claimed = (await pool.query<{ id: string; to_phone: string; template: string; body: string; attempts: number }>(
    `UPDATE sms_outbox SET status = 'sending', attempts = attempts + 1, updated_at = now()
      WHERE id IN (SELECT id FROM sms_outbox WHERE status = 'queued' AND next_attempt_at <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING id, to_phone, template, body, attempts`, [BATCH])).rows;

  for (const row of claimed) {
    const result = await sendSms(f, creds, row.to_phone, row.body, ctx.sendUrl ?? DEFAULT_SEND_URL);
    if (result.ok) {
      await pool.query(`UPDATE sms_outbox SET status = 'sent', sent_at = now(), last_error = NULL, provider_response = $2, updated_at = now() WHERE id = $1`, [row.id, result.response ?? null]);
      summary.sent++;
    } else if (row.attempts >= MAX_ATTEMPTS) {
      await pool.query(`UPDATE sms_outbox SET status = 'failed', last_error = $2, provider_response = $3, updated_at = now() WHERE id = $1`, [row.id, (result.error ?? 'unknown error').slice(0, 300), result.response ?? null]);
      logger.error({ id: row.id, template: row.template, to: maskPhone(row.to_phone), attempts: row.attempts, error: result.error }, 'SMS failed permanently');
      await raiseAlert(pool, { kind: 'sms_failed', title: 'A customer text message could not be sent after several tries', body: { id: Number(row.id), template: row.template, error: (result.error ?? '').slice(0, 200) } }).catch(() => undefined);
      summary.failed++;
    } else {
      await pool.query(`UPDATE sms_outbox SET status = 'queued', last_error = $2, provider_response = $3, next_attempt_at = now() + make_interval(mins => $4), updated_at = now() WHERE id = $1`,
        [row.id, (result.error ?? 'unknown error').slice(0, 300), result.response ?? null, backoffFor(row.attempts)]);
      summary.retried++;
    }
  }
  return summary;
}

/** Runs the worker every `everyMs` (30 seconds) until stop() is called; a run never overlaps the one before it. */
export function scheduleSmsWorker(ctx: SmsCtx, opts: { everyMs?: number } = {}): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    processOutbox(ctx).catch((err) => ctx.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'SMS worker crashed')).finally(() => { running = false; });
  }, opts.everyMs ?? 30_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

// ---- for people ---------------------------------------------------------------------------------------------------------------------------
export async function listOutbox(pool: Pool, o: { status?: string; limit: number; offset: number }) {
  const where = o.status ? 'WHERE status = $1' : ''; const args = o.status ? [o.status] : [];
  const total = Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM sms_outbox ${where}`, args)).rows[0]!.n);
  const { rows } = await pool.query(`SELECT id, to_phone, template, body, related_type, related_id, status, attempts, last_error, provider_response, created_at, sent_at FROM sms_outbox ${where} ORDER BY id DESC LIMIT ${o.limit} OFFSET ${o.offset}`, args);
  return { total, messages: rows.map((r) => ({ id: Number(r.id), toPhone: r.to_phone as string, template: r.template as string, body: r.body as string, relatedType: r.related_type as string | null, relatedId: r.related_id as string | null, status: r.status as string, attempts: r.attempts as number, lastError: r.last_error as string | null, providerResponse: r.provider_response as string | null, createdAt: r.created_at as Date, sentAt: r.sent_at as Date | null })) };
}

export async function retryMessage(pool: Pool, id: number) {
  const { rows } = await pool.query<{ status: string }>(`SELECT status FROM sms_outbox WHERE id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, 'SMS_NOT_FOUND', 'Message not found.');
  if (!['failed', 'expired'].includes(rows[0].status)) throw new HttpError(409, 'SMS_NOT_RETRYABLE', `Only failed or expired messages can be retried (this one is "${rows[0].status}").`);
  // created_at is reset too, or an expired message would be expired again at the very next sweep.
  await pool.query(`UPDATE sms_outbox SET status = 'queued', attempts = 0, next_attempt_at = now(), created_at = now(), last_error = NULL, updated_at = now() WHERE id = $1 AND status IN ('failed', 'expired')`, [id]);
  return { id, status: 'queued' };
}

export async function smsStatus(ctx: Pick<SmsCtx, 'pool' | 'secretsKey' | 'envCredentials'>) {
  const s = await smsSettings(ctx.pool);
  const { rows } = await ctx.pool.query<{ status: string; n: string }>(`SELECT status, count(*) AS n FROM sms_outbox WHERE created_at >= now() - interval '7 days' GROUP BY status`);
  return { enabled: s.sms_enabled === '1', credentials: await getSafeCredentials(ctx), last7Days: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])) };
}

/** A real send, outside the queue, so the person sees the true outcome and the gateway's raw reply (how the real success format is learned). */
export async function sendTest(ctx: SmsCtx, to: string) {
  const msisdn = toMsisdn(to);
  if (!msisdn) throw new HttpError(422, 'SMS_BAD_PHONE', 'Enter a valid Kenyan mobile number (for example 0712345678).');
  const creds = await getRawCredentials(ctx);
  if (!creds) throw new HttpError(422, 'SMS_NOT_CONFIGURED', 'No Zettatel credentials are saved yet: add them first.');
  const s = await smsSettings(ctx.pool);
  const body = `${s.business_name}\nThis is a test message from your POS. SMS sending is working.`;
  const id = Number((await ctx.pool.query<{ id: string }>(`INSERT INTO sms_outbox (to_phone, template, body, status, attempts) VALUES ($1, 'test', $2, 'sending', 1) RETURNING id`, [msisdn, body])).rows[0]!.id);
  const result = await sendSms(ctx.fetch ?? fetch, creds, msisdn, body, ctx.sendUrl ?? DEFAULT_SEND_URL);
  await ctx.pool.query(`UPDATE sms_outbox SET status = $2, sent_at = CASE WHEN $3 THEN now() END, last_error = $4, provider_response = $5, updated_at = now() WHERE id = $1`,
    [id, result.ok ? 'sent' : 'failed', result.ok, result.ok ? null : (result.error ?? 'unknown error').slice(0, 300), result.response ?? null]);
  return { ok: result.ok, error: result.error ?? null, providerResponse: result.response ?? null, to: maskPhone(msisdn) };
}

/**
 * Immediate, unqueued send for time-critical one-time codes: waiting for the worker would make a login code arrive after it expires. The
 * message is deliberately NOT written to the outbox, because it contains the code.
 */
export async function sendNow(ctx: SmsCtx, to: string, message: string): Promise<{ ok: boolean; error: string | null }> {
  const msisdn = toMsisdn(to);
  if (!msisdn) return { ok: false, error: 'invalid phone number' };
  const creds = await getRawCredentials(ctx);
  if (!creds) return { ok: false, error: 'SMS is not configured' };
  const r = await sendSms(ctx.fetch ?? fetch, creds, msisdn, message, ctx.sendUrl ?? DEFAULT_SEND_URL);
  return { ok: r.ok, error: r.error ?? null };
}
