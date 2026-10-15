const ApiError = require('./ApiError');

/**
 * Turns an axios error from a third-party call (Shopify, WooCommerce) into
 * an ApiError — always as 502 Bad Gateway, never reusing the third party's
 * own status code.
 *
 * Why this matters: the frontend's axios interceptor treats ANY 401 from
 * ANY endpoint as "your login session expired" and force-logs the user out
 * (client.js). If Shopify rejects our stored access token with its own 401
 * and we pass that straight through as *our* API's response status, the
 * frontend can't tell the difference between "your JWT expired" and "the
 * Shopify token in Settings is bad" — it just sees a 401 and logs the user
 * out, which is exactly what was happening here. 502 ("we tried to reach a
 * dependency and it failed") is the semantically correct code for this and
 * doesn't collide with anything the frontend treats specially; the real
 * upstream status is preserved in the message text for debugging.
 */
function fromUpstreamError(err, platform) {
  if (err instanceof ApiError) return err;

  if (err.response) {
    const body = typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data);
    return new ApiError(502, `${platform} rejected the request (their HTTP ${err.response.status}): ${body}`);
  }
  if (err.request) {
    // Request went out, nothing came back — DNS, TLS, timeout, wrong domain, etc.
    return new ApiError(502, `Could not reach ${platform}: ${err.code || err.message}. Double-check the domain/URL in Settings.`);
  }
  return new ApiError(500, `${platform} sync failed: ${err.message}`);
}

module.exports = { fromUpstreamError };
