import express, { type ErrorRequestHandler } from 'express';
import { fileURLToPath } from 'node:url';
import type { Pool } from './db/pool.js';
import { HttpError } from './errors.js';
import { authRouter } from './routes/auth.js';
import { payrollRouter } from './routes/payroll.js';
import { usersRouter } from './routes/users.js';
import { securityRouter } from './routes/security.js';
import { catalogRouter } from './routes/catalog.js';
import { customersRouter } from './routes/customers.js';
import { leadsRouter } from './routes/leads.js';
import { couriersRouter } from './routes/couriers.js';
import { ordersRouter } from './routes/orders.js';
import { posRouter } from './routes/pos.js';
import { reportsRouter } from './routes/reports.js';
import { integrationsRouter } from './routes/integrations.js';
import type { Logger } from './logger.js';
import { cors } from './cors.js';

export interface AppDeps {
  pool: Pool;
  logger: Logger;
  /** How long a login lasts. */
  sessionHours?: number;
  /** Browser origins that may call the API with credentials (the refresh cookie). */
  corsOrigins?: string[];
  /** Number of reverse proxies in front of the server (Railway: 1). */
  trustProxyHops?: number;
  /** Mark the refresh cookie Secure (true on a real HTTPS deployment). */
  secureCookies?: boolean;
  /** SameSite of the refresh cookie: 'strict' unless the screens and the API are on unrelated domains. */
  cookieSameSite?: 'strict' | 'lax' | 'none';
  accessTokenMinutes?: number;
  refreshTokenDays?: number;
  /** Sign-in attempts per address per window. Default 20 per 15 minutes (LOGIN_RATE_LIMIT_MAX overrides the count). `false` = off. */
  signInLimit?: { max: number; windowMinutes: number } | false;
  /** ORDER_REF_KEY: needed to issue order references (converting a lead creates an order). */
  orderRefKey?: string;
  /** SECRETS_KEY: opens the integration secrets kept (encrypted) in the database. */
  secretsKey?: string;
  /** PAYMENT_WEBHOOK_SECRET: the paybill callback token from the environment. */
  webhookSecret?: string;
}

export { HttpError };

export function createApp({ pool, logger, sessionHours = 12, orderRefKey, corsOrigins = [], trustProxyHops = 0, secureCookies = false, cookieSameSite, accessTokenMinutes, refreshTokenDays, signInLimit, secretsKey, webhookSecret }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxyHops > 0) app.set('trust proxy', trustProxyHops);
  app.use(cors(corsOrigins));
  // Signed webhooks (Shopify, WooCommerce) are checked against the exact bytes received, so those routes keep the raw body.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { if ((req as express.Request).originalUrl.startsWith('/api/integrations/')) (req as express.Request & { rawBody?: Buffer }).rawBody = buf; } }));

  // The staff screens: plain files in server/public, no build step. Served under /app with strict headers (scripts and styles only
  // from this server, never framed, never sniffed).
  app.use('/app', (_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache',
    });
    next();
  }, express.static(fileURLToPath(new URL('../public', import.meta.url)), { index: 'index.html' }));
  app.get('/', (_req, res) => { res.redirect('/app/'); });

  // Liveness + database check. Railway uses this to decide whether a deploy is healthy.
  app.get('/api/health', async (_req, res, next) => {
    try {
      const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM schema_migrations');
      res.json({ status: 'ok', database: 'up', migrations: Number(rows[0]?.n ?? 0) });
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'health check failed');
      next(new HttpError(503, 'DATABASE_UNAVAILABLE', 'The database is not reachable.'));
    }
  });

  // Called by outside systems, which have no login: they prove themselves with a secret instead. Mounted before everything that
  // demands a login, so nothing here can fall through to a router that would answer 401.
  app.use('/api/integrations', integrationsRouter(pool, { logger, secretsKey, webhookSecret }));
  app.use('/api/auth', authRouter(pool, { sessionHours, secureCookies, cookieSameSite, accessMinutes: accessTokenMinutes, refreshDays: refreshTokenDays,
    signInLimit: signInLimit ?? { max: Number(process.env.LOGIN_RATE_LIMIT_MAX) || 20, windowMinutes: Number(process.env.LOGIN_RATE_LIMIT_MINUTES) || 15 } }));
  app.use('/api/users', usersRouter(pool));
  app.use('/api/security', securityRouter(pool));
  app.use('/api/payroll', payrollRouter(pool));
  app.use('/api', catalogRouter(pool));
  app.use('/api/customers', customersRouter(pool));
  app.use('/api/leads', leadsRouter(pool, { orderRefKey }));
  app.use('/api', ordersRouter(pool, { orderRefKey }));
  app.use('/api', couriersRouter(pool));
  app.use('/api', posRouter(pool));
  app.use('/api', reportsRouter(pool, { logger }));

  app.use((_req, _res, next) => next(new HttpError(404, 'NOT_FOUND', 'Route not found.')));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message }, details: err.details });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON.' } });
      return;
    }
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  };
  app.use(onError);

  return app;
}
