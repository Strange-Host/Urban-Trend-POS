'use strict';

const defaultDb = require('../config/db');
const logger = require('../utils/logger');
const alerting = require('../services/alerting.service');
const { offsetMinutes } = require('../utils/storeTime');
const { runIntegrityChecks } = require('./checks');

// The nightly integrity job. Ported from the update branch's integrity/job.ts.
// The update branch needed a Postgres advisory lock so only one instance ran at a time; this is one process on one SQLite
// file, so an in-process flag does the same job. Each run is stored in integrity_runs, and a failure raises an alert that
// stays on the managers' screen until it is resolved.

const DEFAULT_HOUR = 2; // 02:00 shop time
let running = false;

/** Milliseconds from `now` until the next occurrence of `hourLocal`:00 shop time. Always > 0. */
function msUntilNextRun(now, hourLocal, offsetMin = offsetMinutes(now)) {
  const localMs = now.getTime() + offsetMin * 60_000;
  const dayMs = 86_400_000;
  let target = Math.floor(localMs / dayMs) * dayMs + hourLocal * 3_600_000;
  if (target <= localMs) target += dayMs;
  return target - localMs;
}

/**
 * One integrity run. Skipped if one is already in progress, or (unless `force`) if one finished within minIntervalHours,
 * so a restart or redeploy does not repeat the check. Returns { ran: true, report } or { ran: false, skipped }.
 */
function runNightlyIntegrity({ db = defaultDb, minIntervalHours = 20, force = false, source = 'nightly' } = {}) {
  if (running) return { ran: false, skipped: 'another run is in progress' };
  running = true;
  try {
    if (!force) {
      const recent = db.prepare(`SELECT 1 FROM integrity_runs WHERE ran_at > datetime('now', '-' || ? || ' hours') LIMIT 1`).get(minIntervalHours);
      if (recent) return { ran: false, skipped: 'ran recently' };
    }
    const report = runIntegrityChecks(db);
    db.prepare('INSERT INTO integrity_runs (source, ok, violation_count, violations, counts, duration_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(source, report.ok ? 1 : 0, report.violations.length, JSON.stringify(report.violations), JSON.stringify(report.counts), report.durationMs);

    if (report.ok) {
      logger.info('[integrity] check passed', { counts: report.counts, ms: report.durationMs });
      alerting.resolveNotices('integrity_failed'); // clean now: the next failure may notify again
    } else {
      logger.error('[integrity] CHECK FAILED: a manager must look at this', { violations: report.violations, counts: report.counts });
      alerting.alertIntegrityFailure(report.violations); // never throws
    }
    return { ran: true, report };
  } finally {
    running = false;
  }
}

/** Runs the integrity job every night at hourLocal:00 shop time until stop() is called. */
function scheduleNightlyIntegrity({ hourLocal = DEFAULT_HOUR } = {}) {
  let timer;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      try { runNightlyIntegrity(); }
      catch (err) { logger.error('[integrity] job crashed', { error: err.message, stack: err.stack }); }
      arm();
    }, msUntilNextRun(new Date(), hourLocal));
    timer.unref?.();
  };
  arm();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

module.exports = { runNightlyIntegrity, scheduleNightlyIntegrity, msUntilNextRun };
