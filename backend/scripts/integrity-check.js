#!/usr/bin/env node
// `npm run integrity`: run the integrity check once, right now, and exit 1 if any rule is broken. Useful after a deploy,
// after restoring a backup, or from a scheduler. Always runs (ignores the "ran recently" skip) and records the run.
// Pass --json for the full report as JSON. Needs shell access to the server; it is not reachable over the API.
require('dotenv').config();
const winston = require('winston');
const logger = require('../src/utils/logger');
const { runNightlyIntegrity } = require('../src/integrity/job');

// This script prints its own result, so keep the job's log lines off the console (they still go to the log files).
// Otherwise --json would not be parseable.
for (const t of logger.transports) if (t instanceof winston.transports.Console) t.silent = true;

try {
  const result = runNightlyIntegrity({ force: true, source: 'cli' });
  if (!result.ran) {
    console.warn(`Integrity check not run: ${result.skipped}.`);
    process.exitCode = 1;
  } else {
    const { report } = result;
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else if (report.ok) console.log(`Integrity check passed (${report.durationMs} ms). Looked at ${report.counts.orders} orders and ${report.counts.payments} payments.`);
    else {
      console.error(`Integrity check FAILED: ${report.violations.length} problem(s).`);
      for (const v of report.violations) console.error(`  [rule ${v.rule ?? '-'}] ${v.check}: ${v.message}`);
    }
    if (!report.ok) process.exitCode = 1;
  }
} catch (err) {
  console.error(`Integrity check could not run: ${err.message}`);
  process.exitCode = 1;
}
