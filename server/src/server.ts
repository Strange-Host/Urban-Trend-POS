import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, { ssl: config.DATABASE_SSL === 'true' });
const server = createApp({ pool, logger }).listen(config.PORT, () => logger.info({ port: config.PORT }, 'server listening'));

// Railway sends SIGTERM on every deploy: stop taking requests, let in-flight ones finish, then close the pool.
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => { void pool.end().then(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
