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
