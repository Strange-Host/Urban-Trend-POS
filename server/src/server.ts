import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { scheduleNightlyIntegrity } from './integrity/job.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, { ssl: config.DATABASE_SSL === 'true' });
const server = createApp({ pool, logger, sessionHours: config.SESSION_HOURS, orderRefKey: config.ORDER_REF_KEY }).listen(config.PORT, () => logger.info({ port: config.PORT }, 'server listening'));

const integrity = config.INTEGRITY_JOB === 'true'
  ? scheduleNightlyIntegrity(pool, { logger, hourLocal: config.INTEGRITY_HOUR })
  : undefined;

// Railway sends SIGTERM on every deploy: stop taking requests, let in-flight ones finish, then close the pool.
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  integrity?.stop();
  server.close(() => { void pool.end().then(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
