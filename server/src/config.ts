import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Railway's private network needs no TLS; a public connection string does. Opt in explicitly.
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  // Scrambles order references. Required only when references are issued (phase 3). NEVER change it once references exist.
  ORDER_REF_KEY: z.string().min(32, 'ORDER_REF_KEY must be at least 32 characters').optional(),
  INTEGRITY_JOB: z.enum(['true', 'false']).default('true'),
  INTEGRITY_HOUR: z.coerce.number().int().min(0).max(23).default(2), // shop time (East Africa Time)
  // How long a login lasts. A shift is one working day, so the default is 12 hours.
  SESSION_HOURS: z.coerce.number().positive().max(72).default(12),
  // Short-lived access tokens are swapped through the refresh cookie. Both are tunable; the defaults match the legacy app.
  ACCESS_TOKEN_MINUTES: z.coerce.number().int().min(1).max(240).default(15),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  // Browser origins allowed to call the API with the refresh cookie, comma separated (e.g. https://pos.example.com,http://localhost:5173).
  CORS_ORIGINS: z.string().default(''),
  // How many proxies (Railway's edge) sit in front of the server, so the client address in audit rows is the real one.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return parsed.data;
}
