import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProduct } from '../src/catalog/products.js';
import { setSettings } from '../src/auth/settings.js';
import { pollSources, scheduleStorePoll } from '../src/integrations/pullOrders.js';
import { createSource, setSourceSecret, type IncomeSource } from '../src/integrations/sources.js';
import { createLogger } from '../src/logger.js';
import { receiveStock } from '../src/stock/stock.js';
import { KEY, makeEnv, type Env } from './orderHelpers.js';
import { fakeFetch, json, shopifyOrder, type FakeFetch } from './storeHelpers.js';

const SECRETS_KEY = 'secrets-key-for-tests-0123456789abcdef-xyz';
const MIN = 60_000;
const A = { actor: 'mona', role: 'manager' };
let env: Env; let sku: string; let n = 0;
beforeAll(async () => {
  env = await makeEnv();
  const p = await createProduct(env.db.pool, { sku: 'POLL-1', name: 'Poll item', priceCents: 150_000, ...A });
  await receiveStock(env.db.pool, { productId: p.id, quantity: 500, ...A });
  sku = p.sku;
});
afterAll(() => env.db.drop());

const q = async (sql: string, a: unknown[] = []) => (await env.db.pool.query(sql, a)).rows;
const setMinutes = (m: string) => setSettings(env.db.pool, { live_poll_minutes: m }, 'test');
const ctx = (f: FakeFetch) => ({ pool: env.db.pool, logger: createLogger('silent'), refKey: KEY, secretsKey: SECRETS_KEY, fetch: f, paceMs: 0 });
async function source(name: string, over: { import?: boolean; active?: boolean } = {}): Promise<IncomeSource> {
  const s = await createSource(env.db.pool, { platform: 'shopify', name, shopDomain: 'urban-trends.myshopify.com', apiKey: 'client-id', importOrders: over.import ?? true });
  await setSourceSecret(env.db.pool, SECRETS_KEY, s, 'client-secret', 'admin');
  if (over.active === false) await q(`UPDATE income_sources SET is_active = false WHERE id = $1`, [s.id]);
  return s;
}
const store = (orders: () => unknown[] | 'down') => fakeFetch((c) => {
  if (c.url.pathname === '/admin/oauth/access_token') return json({ access_token: 'shpat_x', scope: 'read_orders', expires_in: 86_399 });
  const o = orders();
  return o === 'down' ? json({}, { status: 500 }) : json({ orders: o });
});
const asked = (f: FakeFetch) => f.calls.filter((c) => c.url.pathname.endsWith('/orders.json'));
const row = async (id: number) => (await q(`SELECT last_poll_at, last_poll_ok_at, last_poll_error FROM income_sources WHERE id = $1`, [id]))[0];

describe('the safety-net poll', () => {
  it('does nothing when it is switched off in settings', async () => {
    await source('Off'); await setMinutes('0');
    const f = store(() => []);
    expect(await pollSources(ctx(f))).toEqual({ skipped: 'off', polled: [] });
    expect(f.calls).toHaveLength(0);
    await setMinutes('nonsense');
    expect((await pollSources(ctx(f))).skipped).toBe('off');
    await setMinutes('5');
  });

  it('looks back a week the first time, then from just before the last success, and only when a connection is due', async () => {
    await q(`DELETE FROM online_orders`); await q(`DELETE FROM income_sources`);
    const s = await source('Main'); await setMinutes('5');
    const o = shopifyOrder(sku); const f = store(() => [o]);
    const t0 = Date.parse('2026-10-28T08:00:00Z');

    const first = await pollSources(ctx(f), { now: t0 });
    expect(first.polled).toHaveLength(1);
    expect(first.polled[0]).toMatchObject({ id: s.id, ok: true, result: { found: 1, imported: 1 } });
    expect(Date.parse(asked(f)[0]!.url.searchParams.get('updated_at_min')!)).toBe(t0 - 7 * 86_400_000);
    expect(asked(f)[0]!.url.searchParams.get('created_at_min')).toBeNull();   // changed OR new, so a cancellation of an older order is seen too
    expect(new Date((await row(s.id)).last_poll_ok_at).getTime()).toBe(t0);

    // Not due yet: no request at all.
    expect((await pollSources(ctx(f), { now: t0 + 2 * MIN })).polled).toEqual([]);
    expect(asked(f)).toHaveLength(1);

    // Due: starts ten minutes before the last success, and finds nothing new to do with the order it already has.
    const second = await pollSources(ctx(f), { now: t0 + 6 * MIN });
    expect(second.polled[0]).toMatchObject({ ok: true, result: { imported: 0, unchanged: 1 } });
    expect(Date.parse(asked(f)[1]!.url.searchParams.get('updated_at_min')!)).toBe(t0 - 10 * MIN);
  });

  it('a failing store is recorded and not hammered, and the next success still starts where the last good one ended', async () => {
    await q(`DELETE FROM online_orders`); await q(`DELETE FROM income_sources`);
    const s = await source('Flaky'); await setMinutes('5');
    let mode: 'ok' | 'down' = 'ok';
    const f = store(() => (mode === 'down' ? 'down' : []));
    const t0 = Date.parse('2026-10-28T08:00:00Z');
    await pollSources(ctx(f), { now: t0 });                                        // good
    mode = 'down';
    const bad = await pollSources(ctx(f), { now: t0 + 6 * MIN });
    expect(bad.polled[0]).toMatchObject({ ok: false, error: expect.stringContaining('HTTP 500') });
    expect(await row(s.id)).toMatchObject({ last_poll_error: expect.stringContaining('HTTP 500') });
    expect(new Date((await row(s.id)).last_poll_at).getTime()).toBe(t0 + 6 * MIN);          // the attempt is noted, so it waits its turn
    expect(new Date((await row(s.id)).last_poll_ok_at).getTime()).toBe(t0);                  // the window does not move
    expect((await pollSources(ctx(f), { now: t0 + 8 * MIN })).polled).toEqual([]);         // not hammered
    mode = 'ok';
    const good = await pollSources(ctx(f), { now: t0 + 12 * MIN });
    expect(good.polled[0]).toMatchObject({ ok: true });
    expect(Date.parse(asked(f).at(-1)!.url.searchParams.get('updated_at_min')!)).toBe(t0 - 10 * MIN); // no orders skipped across the outage
    expect(await row(s.id)).toMatchObject({ last_poll_error: null });
    expect(new Date((await row(s.id)).last_poll_ok_at).getTime()).toBe(t0 + 12 * MIN);
  });

  it('an order we failed to save does not move "caught up to" forward, so the next poll gets it', async () => {
    await q(`DELETE FROM online_orders`); await q(`DELETE FROM income_sources`);
    const s = await source('Saves'); await setMinutes('5');
    const o = shopifyOrder(sku); const f = store(() => [o]);
    const t0 = Date.parse('2026-10-28T08:00:00Z');
    await q(`ALTER TABLE online_orders RENAME TO online_orders_off`);
    try {
      const r = await pollSources(ctx(f), { now: t0 });
      expect(r.polled[0]).toMatchObject({ ok: false, result: { failed: 1 } });
    } finally { await q(`ALTER TABLE online_orders_off RENAME TO online_orders`); }
    expect((await row(s.id)).last_poll_ok_at).toBeNull();
    expect((await row(s.id)).last_poll_error).toContain('could not be saved');
    const again = await pollSources(ctx(f), { now: t0 + 6 * MIN });
    expect(again.polled[0]).toMatchObject({ ok: true, result: { imported: 1, failed: 0 } });
    expect(Date.parse(asked(f).at(-1)!.url.searchParams.get('updated_at_min')!)).toBe(t0 + 6 * MIN - 7 * 86_400_000); // still the first-time window
  });

  it('skips switched-off connections and ones that do not import orders; never looks back past 60 days', async () => {
    await q(`DELETE FROM online_orders`); await q(`DELETE FROM income_sources`);
    await source('Inactive', { active: false }); await source('No import', { import: false });
    const live = await source('Live'); await setMinutes('5');
    const f = store(() => []); const t0 = Date.parse('2026-10-28T08:00:00Z');
    expect((await pollSources(ctx(f), { now: t0 })).polled.map((p) => p.id)).toEqual([live.id]);
    await q(`UPDATE income_sources SET last_poll_at = $2, last_poll_ok_at = $3 WHERE id = $1`, [live.id, new Date(t0 - 3_600_000), new Date(t0 - 90 * 86_400_000)]);
    await pollSources(ctx(f), { now: t0 });
    expect(Date.parse(asked(f).at(-1)!.url.searchParams.get('updated_at_min')!)).toBe(t0 - 60 * 86_400_000);
  });

  it('only one instance polls at a time', async () => {
    await q(`DELETE FROM online_orders`); await q(`DELETE FROM income_sources`);
    await source('Locked'); await setMinutes('5');
    const other = await env.db.pool.connect();
    try {
      await other.query('SELECT pg_advisory_lock(727401003)');
      const f = store(() => []);
      expect(await pollSources(ctx(f), { now: Date.now() })).toEqual({ skipped: 'another instance is running', polled: [] });
      expect(f.calls).toHaveLength(0);
    } finally { await other.query('SELECT pg_advisory_unlock(727401003)'); other.release(); }
  });

  it('the schedule keeps polling while it runs, and really stops when told to', async () => {
    await q(`DELETE FROM online_orders`); await q(`DELETE FROM income_sources`);
    const s = await source('Scheduled'); await setMinutes('5');
    const f = store(() => []);
    const job = scheduleStorePoll(ctx(f), { everyMs: 20 });
    const polls = () => asked(f).length;
    const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); };
    try {
      await until(() => polls() >= 1);
      expect(polls()).toBe(1);
      // Make the connection due again: a live schedule must notice and poll it a second time.
      await q(`UPDATE income_sources SET last_poll_at = NULL WHERE id = $1`, [s.id]);
      await until(() => polls() >= 2);
      expect(polls()).toBe(2);
    } finally { job.stop(); }
    // Now due again, but the schedule is stopped: nothing may happen.
    await new Promise((r) => setTimeout(r, 100));
    await q(`UPDATE income_sources SET last_poll_at = NULL WHERE id = $1`, [s.id]);
    await new Promise((r) => setTimeout(r, 250));
    expect(polls()).toBe(2);
  });
});
