import { raiseAlert } from '../alerts/alerts.js';
import { getSettings } from '../auth/settings.js';
import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { HttpError } from '../errors.js';
import type { Logger } from '../logger.js';
import { importOnlineOrder, normalize, platformLabel, type ImportOutcome } from './onlineOrders.js';
import { noticeHandlers } from './notices.js';
import { getSource, type IncomeSource } from './sources.js';
import { fetchSourceOrders, StoreError, type StoreFetch } from './storeClients.js';
import { recordWebhookEvent } from './webhookEvents.js';

export interface PullCtx {
  pool: Pool; logger: Logger; refKey: string; secretsKey?: string;
  /** Injected in tests; the real fetch otherwise. */
  fetch?: StoreFetch;
  /** Pause between pages of a store's answer (their rate limits). Tests set 0. */
  paceMs?: number;
}

export interface PullResult {
  found: number; imported: number; cancelled: number; unchanged: number; ignored: number;
  /** Orders that could not be taken as they stand: each is kept, as received, for a person (one alert). */
  needsReview: number;
  /** Orders that were cancelled on the store but could not be undone here (money on them, or already out for delivery). */
  needsAttention: number;
  /** Faults of ours (the database). The next pull tries again. */
  failed: number;
  errors: string[];
}

const MAX_REPORTED = 5;
export const DEFAULT_PULL_DAYS = 60;

/**
 * Asks a store for its orders and hands each to the same importer the webhooks use, so a pull and a webhook can never disagree and an
 * order that arrived both ways is still one order. Running it twice changes nothing the second time: the importer is keyed on the store's
 * order id, and a notice about the same problem is kept (and alerted on) once, not on every pull.
 */
export async function pullOrders(ctx: PullCtx, sourceId: number, opts: { days?: number; updatedSince?: Date } = {}): Promise<PullResult> {
  const source = await getSource(ctx.pool, sourceId);
  if (!source) throw new HttpError(404, 'SOURCE_NOT_FOUND', 'That connection does not exist.');
  if (!source.isActive) throw new HttpError(409, 'SOURCE_INACTIVE', 'That connection is switched off.');

  let raws;
  try {
    const filter = opts.updatedSince ? { updatedSince: opts.updatedSince } : { createdSince: new Date(Date.now() - (opts.days ?? DEFAULT_PULL_DAYS) * 86_400_000) };
    raws = await fetchSourceOrders(ctx.pool, ctx.secretsKey, source, filter, ctx.fetch ?? fetch, { paceMs: ctx.paceMs });
  } catch (err) {
    if (err instanceof StoreError) throw new HttpError(502, 'STORE_ERROR', err.message);
    throw err;
  }

  const result: PullResult = { found: raws.length, imported: 0, cancelled: 0, unchanged: 0, ignored: 0, needsReview: 0, needsAttention: 0, failed: 0, errors: [] };
  const { keepForReview } = noticeHandlers(ctx.pool, ctx.logger);
  const note = (msg: string) => { if (result.errors.length < MAX_REPORTED) result.errors.push(msg); };
  const label = platformLabel(source.platform);

  for (const raw of raws) {
    const norm = normalize(source.platform, raw);
    try {
      const outcome = await importOnlineOrder({ pool: ctx.pool, refKey: ctx.refKey }, source, raw);
      await noteOutcome(ctx.pool, source, norm.externalId, outcome);
      switch (outcome.action) {
        case 'created': result.imported++; break;
        case 'cancelled': result.cancelled++; break;
        case 'unchanged': result.unchanged++; break;
        case 'ignored': result.ignored++; break;
        case 'needs_attention': result.needsAttention++; note(`${norm.label}: ${outcome.reason}`); break;
      }
    } catch (err) {
      if (err instanceof HttpError) {
        result.needsReview++; note(`${norm.label}: ${err.message}`);
        await keepForReview({ provider: source.platform, kind: 'pull', body: { externalId: norm.externalId, label: norm.label }, reason: `${err.code}: ${err.message}`, eventKey: `${source.id}:pull:${norm.externalId}`, reply: { status: 200, body: {} },
          alertTitle: `A ${label} order could not be imported: a person must check it` });
      } else {
        result.failed++; note(`${norm.label}: ${err instanceof Error ? err.message : String(err)}`);
        ctx.logger.error({ err: err instanceof Error ? err.message : String(err), source: source.id, order: norm.externalId }, 'pulling an online order failed');
      }
    }
  }
  return result;
}

/** The outcomes a person must hear about, once each: the event log's unique key is the memory, so every later pull finds it and stays silent. */
async function noteOutcome(pool: Pool, source: IncomeSource, externalId: string, outcome: ImportOutcome): Promise<void> {
  const paid = outcome.action === 'created' && outcome.paidOnline;
  if (!paid && outcome.action !== 'needs_attention') return;
  const label = platformLabel(source.platform);
  await withTransaction(pool, async (c) => {
    const isNew = await recordWebhookEvent(c, { provider: source.platform, kind: 'pull_attention', eventKey: `${source.id}:${externalId}:${outcome.action}`, status: 'processed', payload: { externalId }, result: outcome });
    if (!isNew) return;
    if (outcome.action === 'created') await raiseAlert(c, { kind: 'online_order_paid_online', title: `${label} order imported as already paid online: record its payment before dispatch`, body: { orderRef: outcome.orderRef } });
    else if (outcome.action === 'needs_attention') await raiseAlert(c, { kind: 'online_order_needs_attention', title: `${label} order needs a person: ${outcome.orderRef}`, body: { orderRef: outcome.orderRef, reason: outcome.reason } });
  });
}

// ---- the safety-net poll -----------------------------------------------------------------------------------------------------
// Webhooks can be missed (the server was down, the store gave up after repeated failures). So every few minutes each connection is also
// asked "what was created or changed since I last looked?" This is also what keeps a store whose webhooks are off reasonably current.

const POLL_LOCK = 727_401_003;
const OVERLAP_MS = 10 * 60_000;               // look back a little past the last success: clocks differ, and a missed second is a missed order
const FIRST_LOOKBACK_MS = 7 * 86_400_000;
const MAX_LOOKBACK_MS = 60 * 86_400_000;      // Shopify shows an app nothing older than 60 days without read_all_orders

export interface PollResult { skipped?: 'off' | 'another instance is running'; polled: { id: number; ok: boolean; error?: string; result?: PullResult }[] }

/** One pass. Safe to call from every instance and every minute: a database lock lets one run at a time, and each connection has its own interval. */
export async function pollSources(ctx: PullCtx, opts: { now?: number } = {}): Promise<PollResult> {
  const now = opts.now ?? Date.now();
  const minutes = parseInt((await getSettings(ctx.pool)).live_poll_minutes ?? '5', 10);
  if (!Number.isFinite(minutes) || minutes < 1) return { skipped: 'off', polled: [] };

  const client = await ctx.pool.connect();
  try {
    const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [POLL_LOCK]);
    if (!got.rows[0]!.ok) return { skipped: 'another instance is running', polled: [] };

    const { rows } = await client.query<{ id: string }>(`SELECT id FROM income_sources WHERE is_active AND import_orders ORDER BY id`);
    const polled: PollResult['polled'] = [];
    for (const { id } of rows) {
      const source = (await getSource(ctx.pool, Number(id)))!;
      const last = source.lastPollAt?.getTime() ?? 0;
      if (now - last < minutes * 60_000 - 5_000) continue;
      const since = source.lastPollOkAt ? Math.max(source.lastPollOkAt.getTime() - OVERLAP_MS, now - MAX_LOOKBACK_MS) : now - FIRST_LOOKBACK_MS;
      const stamp = new Date(now);
      try {
        const result = await pullOrders(ctx, source.id, { updatedSince: new Date(since) });
        // Only a clean pass moves "caught up to" forward. Orders that failed on our side must be looked at again.
        const clean = result.failed === 0;
        await ctx.pool.query(`UPDATE income_sources SET last_poll_at = $2, last_poll_ok_at = CASE WHEN $3 THEN $2 ELSE last_poll_ok_at END, last_poll_error = $4 WHERE id = $1`,
          [source.id, stamp, clean, clean ? null : `${result.failed} order(s) could not be saved; they will be tried again`]);
        polled.push({ id: source.id, ok: clean, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.warn({ source: source.id, err: message }, 'poll of an online store failed');
        await ctx.pool.query(`UPDATE income_sources SET last_poll_at = $2, last_poll_error = $3 WHERE id = $1`, [source.id, stamp, message.slice(0, 300)]);
        polled.push({ id: source.id, ok: false, error: message });
      }
    }
    return { polled };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [POLL_LOCK]).catch(() => undefined);
    client.release();
  }
}

/** Runs the poll once a minute (each connection keeps its own, longer, interval) until stop() is called. */
export function scheduleStorePoll(ctx: PullCtx, opts: { everyMs?: number } = {}): { stop: () => void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    pollSources(ctx).catch((err) => ctx.logger.error({ err: err instanceof Error ? err.message : String(err) }, 'store poll crashed')).finally(() => { running = false; });
  }, opts.everyMs ?? 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
