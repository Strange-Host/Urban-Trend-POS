import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { scheduleNightlyIntegrity } from './integrity/job.js';
import { scheduleStorePoll } from './integrations/pullOrders.js';
import { scheduleSmsWorker } from './sms/sms.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, { ssl: config.DATABASE_SSL === 'true' });
const smsEnv = { userId: config.ZETTATEL_USER_ID, password: config.ZETTATEL_PASSWORD, senderId: config.ZETTATEL_SENDER_ID };
const server = createApp({ pool, logger, sessionHours: config.SESSION_HOURS, orderRefKey: config.ORDER_REF_KEY, secretsKey: config.SECRETS_KEY, webhookSecret: config.PAYMENT_WEBHOOK_SECRET, sms: { envCredentials: smsEnv, sendUrl: config.ZETTATEL_SEND_URL },
  corsOrigins: config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean), trustProxyHops: config.TRUST_PROXY_HOPS,
  secureCookies: config.NODE_ENV === 'production', cookieSameSite: config.REFRESH_COOKIE_SAMESITE, accessTokenMinutes: config.ACCESS_TOKEN_MINUTES, refreshTokenDays: config.REFRESH_TOKEN_DAYS,
  signInLimit: { max: config.LOGIN_RATE_LIMIT_MAX, windowMinutes: config.LOGIN_RATE_LIMIT_MINUTES } }).listen(config.PORT, () => logger.info({ port: config.PORT }, 'server listening'));

const integrity = config.INTEGRITY_JOB === 'true'
  ? scheduleNightlyIntegrity(pool, { logger, hourLocal: config.INTEGRITY_HOUR })
  : undefined;

const storePoll = config.STORE_POLL_JOB === 'true' && config.ORDER_REF_KEY
  ? scheduleStorePoll({ pool, logger, refKey: config.ORDER_REF_KEY, secretsKey: config.SECRETS_KEY })
  : undefined;

const smsWorker = config.SMS_WORKER === 'true'
  ? scheduleSmsWorker({ pool, logger, secretsKey: config.SECRETS_KEY, envCredentials: smsEnv, sendUrl: config.ZETTATEL_SEND_URL })
  : undefined;

// Railway sends SIGTERM on every deploy: stop taking requests, let in-flight ones finish, then close the pool.
function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  integrity?.stop();
  storePoll?.stop();
  smsWorker?.stop();
  server.close(() => { void pool.end().then(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
