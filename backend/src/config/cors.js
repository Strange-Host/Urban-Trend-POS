// CORS policy. Zero-config by design: with no CORS_ORIGIN set, the browser may
// call this API from the machine itself and from the shop's own network
// (localhost, 127.0.0.1, 10.x, 172.16-31.x, 192.168.x, *.local) on any port —
// which is every normal setup: a PC on the counter, a phone or tablet on the
// same WiFi. A page served from the open internet is NOT allowed, so a random
// website a staff member visits can't talk to the API with their browser.
//
// Hosting the frontend somewhere public (a domain, Vercel...)? Set CORS_ORIGIN to
// that origin (comma-separated for several) and ONLY those are allowed.

function isPrivateNetworkOrigin(origin) {
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function parseConfigured(raw) {
  const list = String(raw || '').split(',').map((o) => o.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

/**
 * `onBlocked(origin)` is called at most once per distinct origin, so the log
 * says what to do the first time it happens and then stays quiet.
 */
function buildCorsOptions({ configured, onBlocked }) {
  // `configured` may be a function so the allow-list can be edited in Settings and take
  // effect on the very next request, with no restart.
  const reported = new Set();

  return {
    credentials: true,
    origin(origin, callback) {
      // No Origin header: not a cross-origin browser request (same-origin page,
      // curl, a payment provider's server calling a webhook).
      if (!origin) return callback(null, true);

      const list = parseConfigured(typeof configured === 'function' ? configured() : configured);
      const allowed = list ? list.includes(origin) : isPrivateNetworkOrigin(origin);
      if (allowed) return callback(null, true);

      if (onBlocked && !reported.has(origin)) {
        reported.add(origin);
        onBlocked(origin);
      }
      // Refuse WITHOUT throwing: the browser blocks the response, and the request
      // doesn't turn into a 500 with an error stack in the logs.
      return callback(null, false);
    },
  };
}

module.exports = { buildCorsOptions, isPrivateNetworkOrigin, parseConfigured };
