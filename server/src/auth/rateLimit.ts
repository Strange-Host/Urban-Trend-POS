import type { RequestHandler } from 'express';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';

// A per-address ceiling on the endpoints someone can guess their way through (password, PIN, unlock). It sits beside the per-account
// lockout: lockout stops guessing at one person, this stops one address trying many people, or changing the person each time.
// Counted in the database (fixed windows), so every server instance shares the count and a restart resets nothing.
export interface RateLimitOptions {
  /** Which counter. Routes that share a scope share the allowance. */
  scope: string;
  max: number;
  windowMinutes: number;
}

let lastSweep = 0;

export function rateLimit(pool: Pool, opts: RateLimitOptions): RequestHandler {
  const seconds = opts.windowMinutes * 60;
  return (req, res, next) => {
    const key = `${opts.scope}:${req.ip ?? 'unknown'}`;
    pool.query<{ count: number; reset: number }>(
      `INSERT INTO rate_limits (key, window_start, count)
       VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2::float8) * $2::float8), 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count, EXTRACT(EPOCH FROM (window_start + make_interval(secs => $2::float8) - now()))::float8 AS reset`, [key, seconds],
    ).then(({ rows }) => {
      const { count, reset } = rows[0]!;
      const wait = Math.max(1, Math.ceil(reset));
      res.set({ 'RateLimit-Limit': String(opts.max), 'RateLimit-Remaining': String(Math.max(0, opts.max - count)), 'RateLimit-Reset': String(wait) });
      if (count > opts.max) {
        res.set('Retry-After', String(wait));
        const minutes = Math.ceil(wait / 60);
        return next(new HttpError(429, 'RATE_LIMITED', `Too many sign-in attempts from this address. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`));
      }
      // Old windows are useless; sweep them now and then, never on the request's own time.
      if (Date.now() - lastSweep > 3_600_000) {
        lastSweep = Date.now();
        void pool.query(`DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`).catch(() => undefined);
      }
      next();
    }).catch(next);
  };
}
