import type { Pool } from '../db/pool.js';
import type { Logger } from '../logger.js';
import { runIntegrityChecks, type IntegrityReport } from './checks.js';

const LOCK_KEY = 727_401_002;
const EAT_OFFSET_HOURS = 3; // East Africa Time, no daylight saving

/** Milliseconds from `now` until the next occurrence of `hourLocal`:00 shop time (East Africa Time). Always > 0. */
export function msUntilNextRun(now: Date, hourLocal: number): number {
  const localMs = now.getTime() + EAT_OFFSET_HOURS * 3_600_000;
  const dayMs = 86_400_000;
  const startOfLocalDay = Math.floor(localMs / dayMs) * dayMs;
  let target = startOfLocalDay + hourLocal * 3_600_000;
  if (target <= localMs) target += dayMs;
  return target - localMs;
}

export type NightlyResult =
  | { ran: true; report: IntegrityReport }
  | { ran: false; skipped: 'another instance is running' | 'ran recently' };

/**
 * One integrity run, safe to call from every instance: a database lock lets only one run at a time, and a run is
 * skipped if one finished within minIntervalHours. The checks read a single consistent snapshot, so a payment posting
 * mid-run cannot make a healthy ledger look broken. The result is stored in integrity_runs.
 */
export async function runNightlyIntegrity(pool: Pool, opts: { logger: Logger; minIntervalHours?: number; force?: boolean }): Promise<NightlyResult> {
  const client = await pool.connect();
  try {
    const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
    if (!got.rows[0]!.ok) return { ran: false, skipped: 'another instance is running' };

    if (!opts.force) {
      const hours = opts.minIntervalHours ?? 20;
      const recent = await client.query(`SELECT 1 FROM integrity_runs WHERE ran_at > now() - make_interval(hours => $1::int) LIMIT 1`, [hours]);
      if (recent.rows[0]) return { ran: false, skipped: 'ran recently' };
    }

    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    let report: IntegrityReport;
    try {
      report = await runIntegrityChecks(client);
    } finally {
      await client.query('COMMIT');
    }
    await client.query('INSERT INTO integrity_runs (ok, violations, counts) VALUES ($1, $2, $3)',
      [report.ok, JSON.stringify(report.violations), JSON.stringify(report.counts)]);

    if (report.ok) opts.logger.info({ counts: report.counts, ms: report.durationMs }, 'integrity check passed');
    else opts.logger.error({ violations: report.violations, counts: report.counts }, 'INTEGRITY CHECK FAILED: a manager must look at this');
    return { ran: true, report };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

/** Runs the integrity job every night at hourLocal:00 shop time until stop() is called. */
export function scheduleNightlyIntegrity(pool: Pool, opts: { logger: Logger; hourLocal?: number }): { stop: () => void } {
  const hour = opts.hourLocal ?? 2;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try { await runNightlyIntegrity(pool, { logger: opts.logger }); }
      catch (err) { opts.logger.error({ err: (err as Error).message }, 'integrity job crashed'); }
      arm();
    }, msUntilNextRun(new Date(), hour));
    timer.unref();
  };
  arm();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
