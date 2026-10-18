import express, { type ErrorRequestHandler } from 'express';
import type { Pool } from './db/pool.js';
import { HttpError } from './errors.js';
import type { Logger } from './logger.js';

export interface AppDeps {
  pool: Pool;
  logger: Logger;
}

export { HttpError };

export function createApp({ pool, logger }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

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
