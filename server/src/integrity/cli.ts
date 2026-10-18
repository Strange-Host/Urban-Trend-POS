import { loadConfig } from '../config.js';
import { createPool, waitForDatabase } from '../db/pool.js';
import { createLogger } from '../logger.js';
import { runNightlyIntegrity } from './job.js';

// `npm run integrity`: run the check once, right now, and exit non-zero if anything is wrong. Useful after a deploy,
// after restoring a backup, or from a scheduler. Always runs (ignores the "ran recently" skip).
const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, { ssl: config.DATABASE_SSL === 'true', max: 2 });
try {
  await waitForDatabase(pool);
  const result = await runNightlyIntegrity(pool, { logger, force: true });
  if (!result.ran) logger.warn({ skipped: result.skipped }, 'integrity check not run');
  else if (!result.report.ok) process.exitCode = 1;
} catch (err) {
  logger.error({ err: (err as Error).message }, 'integrity check could not run');
  process.exitCode = 1;
} finally {
  await pool.end();
}
