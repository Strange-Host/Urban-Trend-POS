const logger = require('./logger');

const PLACEHOLDER_JWT_SECRET = 'change_this_to_a_long_random_string';
const PLACEHOLDER_ENCRYPTION_KEY = 'change_this_to_a_different_long_random_string';

/**
 * Checks the handful of env vars that are load-bearing for security —
 * catching a misconfiguration here, at startup, is much better than
 * catching it after something's gone wrong in production. In production,
 * refuses to start at all rather than run in a silently weakened state;
 * in development, warns and continues (a placeholder secret on your own
 * laptop isn't a real exposure the way it is on a real deployment).
 */
function validateEnv() {
  const isProduction = process.env.NODE_ENV === 'production';
  const errors = [];

  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === PLACEHOLDER_JWT_SECRET) {
    errors.push('JWT_SECRET is not set (or still the placeholder) — set it to a long random string in backend/.env, or delete the line and the server will generate one.');
  }
  if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY === PLACEHOLDER_ENCRYPTION_KEY) {
    errors.push('ENCRYPTION_KEY is not set (or still the placeholder) — set it to a long random string in backend/.env, or delete the line and the server will generate one.');
  }
  // Using the same value for both means a leak of one secret compromises
  // the other too (an attacker who gets JWT_SECRET could also decrypt
  // stored Shopify/WooCommerce credentials, and vice versa) — the whole
  // point of having two separate secrets is that they fail independently.
  if (process.env.JWT_SECRET && process.env.ENCRYPTION_KEY && process.env.JWT_SECRET === process.env.ENCRYPTION_KEY) {
    errors.push('JWT_SECRET and ENCRYPTION_KEY must be different values — set ENCRYPTION_KEY to a distinct random string.');
  }

  if (errors.length === 0) return;

  logger.error(`Startup configuration problem${errors.length > 1 ? 's' : ''}:\n${errors.map((e) => `  - ${e}`).join('\n')}`);

  if (isProduction) {
    logger.error('Refusing to start in production with the above unresolved.');
    process.exit(1);
  } else {
    logger.warn('Continuing to start in development despite the above — fix before deploying to production.');
  }
}

module.exports = validateEnv;
