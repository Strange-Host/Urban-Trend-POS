import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createPool, waitForDatabase } from './pool.js';
import { runMigrations } from './migrate.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, { ssl: config.DATABASE_SSL === 'true', max: 2 });

try {
  await waitForDatabase(pool);
  const result = await runMigrations(pool);
  log.info({ applied: result.applied, total: result.total }, result.applied.length ? 'migrations applied' : 'database already up to date');
} catch (err) {
  log.error({ err: (err as Error).message }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
