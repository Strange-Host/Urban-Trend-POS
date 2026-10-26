import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['tests/globalSetup.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000, // first run starts a Postgres
    pool: 'forks',
    // The sign-in limit is per address, and every test connects from the same one. Tests of the limit itself pass their own.
    env: { LOGIN_RATE_LIMIT_MAX: '100000' },
  },
});
