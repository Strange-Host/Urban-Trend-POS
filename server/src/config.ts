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
  // The safety-net poll of the online stores (Shopify, WooCommerce): catches orders whose webhooks were missed. Off until turned on, so a staging copy does not
  // quietly start importing a real store's orders. How often is the live_poll_minutes setting (default 5; 0 stops it).
  STORE_POLL_JOB: z.enum(['true', 'false']).default('false'),
  // Customer text messages (Zettatel). The worker only sends what was queued, and nothing is queued until sms_enabled is switched on in settings.
  SMS_WORKER: z.enum(['true', 'false']).default('true'),
  // Credentials can live in the database (Settings > SMS, encrypted) or here, for deployments that keep secrets out of the database. The database wins.
  ZETTATEL_USER_ID: z.string().optional(),
  ZETTATEL_PASSWORD: z.string().optional(),
  ZETTATEL_SENDER_ID: z.string().optional(),
  ZETTATEL_SEND_URL: z.string().url().optional(),
  INTEGRITY_HOUR: z.coerce.number().int().min(0).max(23).default(2), // shop time (East Africa Time)
  // How long a login lasts. A shift is one working day, so the default is 12 hours.
  SESSION_HOURS: z.coerce.number().positive().max(72).default(12),
  // Short-lived access tokens are swapped through the refresh cookie. Both are tunable; the defaults match the legacy app.
  ACCESS_TOKEN_MINUTES: z.coerce.number().int().min(1).max(240).default(15),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  // 'strict' when the screens and the API share a site (same registrable domain, or localhost); 'none' if they are on unrelated domains.
  REFRESH_COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),
  // Browser origins allowed to call the API with the refresh cookie, comma separated (e.g. https://pos.example.com,http://localhost:5173).
  CORS_ORIGINS: z.string().default(''),
  // How many proxies (Railway's edge) sit in front of the server, so the client address in audit rows is the real one.
  // Default 1 = Railway's edge. With 0 behind a proxy every visitor looks like the proxy and would share one sign-in allowance.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  // Sign-in attempts (password, PIN, unlock) allowed per address per window. Per-account lockout applies on top.
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(20),
  LOGIN_RATE_LIMIT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  // Opens the integration secrets stored (encrypted) in the database. At least 32 characters. NEVER change it once secrets are stored: they could no longer be read.
  SECRETS_KEY: z.string().min(32, 'SECRETS_KEY must be at least 32 characters').optional(),
  // The token inside the callback URL registered with Safaricom. The legacy server uses the same variable, so existing registrations keep working.
  PAYMENT_WEBHOOK_SECRET: z.string().min(16, 'PAYMENT_WEBHOOK_SECRET must be at least 16 characters').optional(),
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
