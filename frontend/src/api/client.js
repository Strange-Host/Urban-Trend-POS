import axios from 'axios';
import { USE_NEW_SERVER, NEW_API_BASE_URL } from './newServer';
import { adaptSessionPayload } from './adapters/auth-shape';

// Zero-config default: the API is on the same machine that served this page,
// port 4000. Opening the app from a phone at http://192.168.1.42:5173 therefore
// talks to http://192.168.1.42:4000 by itself - no .env needed. Set VITE_API_URL
// only if the backend lives somewhere else (a different host, a public domain).
export const API_BASE_URL = USE_NEW_SERVER ? NEW_API_BASE_URL : (import.meta.env.VITE_API_URL
  || `${window.location.protocol}//${window.location.hostname || 'localhost'}:4000/api`);

// 2.3 — the access token lives ONLY in this module-level variable, never
// in localStorage/sessionStorage. Anything that can read localStorage
// (any XSS anywhere on the page, a malicious browser extension, etc.) can
// silently exfiltrate a long-lived credential; a plain JS variable is
// invisible to anything outside this module's own closure and vanishes
// on a hard reload — which is fine, since AuthContext re-establishes it
// on boot via the httpOnly refresh cookie (performRefresh below), the
// same mechanism already used for the normal 401-triggered refresh.
let accessToken = null;
export function setAccessToken(token) { accessToken = token; }
export function clearAccessToken() { accessToken = null; }

// AuthContext registers these so this plain module can (a) learn the session's timing rules whenever the server
// sends them, (b) pause a request while the screen is locked and carry on after the password/PIN unlocks it, and
// (c) ask "confirm it's you" before a risky action and then repeat the action, without the caller having to care.
let handlers = {};
export function registerSessionHandlers(h) { handlers = h || {}; }

const FLASH_KEY = 'ut_flash';
/** A one-line notice shown on the sign-in screen (e.g. why the person was signed out). */
export function setFlash(message) { try { sessionStorage.setItem(FLASH_KEY, message); } catch { /* ignore */ } }
export function takeFlash() {
  try { const m = sessionStorage.getItem(FLASH_KEY); if (m) sessionStorage.removeItem(FLASH_KEY); return m; } catch { return null; }
}
const errorCode = (err) => err?.response?.data?.error?.code;

// withCredentials: true — the refresh token lives in an httpOnly,
// SameSite=Strict cookie (never in localStorage, never readable by JS,
// even via XSS) instead of the response body. The browser attaches it
// automatically on requests to /api/auth/*; this flag is what makes the
// browser actually do that for cross-origin requests (frontend and
// backend are different origins even on localhost — different ports).
const client = axios.create({ baseURL: API_BASE_URL, withCredentials: true });

client.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

function clearSessionAndRedirect(message) {
  clearAccessToken();
  if (message) setFlash(message);
  // One-time cleanup for anyone who still has these from before this fix
  // shipped — nothing writes them anymore, but a stale leftover value
  // sitting in localStorage forever is just confusing, not dangerous.
  localStorage.removeItem('ut_token');
  localStorage.removeItem('ut_user');
  if (!window.location.pathname.includes('/login')) {
    window.location.href = '/login';
  }
}

// Access tokens are short-lived (15m) now, so hitting a 401 mid-session is
// routine, not exceptional — this refreshes silently and retries once
// rather than kicking the user back to the login screen every 15 minutes.
// Concurrent requests that all 401 around the same moment share ONE
// refresh call (the refresh token is single-use/rotated, so firing several
// at once would make all but the first fail). Also used directly by
// AuthContext on app boot, to restore a session from the httpOnly cookie
// after a hard reload (which clears the in-memory accessToken above).
let refreshPromise = null;

export function performRefresh() {
  if (!refreshPromise) {
    // No refresh token to read/send here — it's an httpOnly cookie, the
    // browser attaches it automatically because of withCredentials above.
    // Plain axios, not `client` — going through `client` here would recurse into this same interceptor.
    refreshPromise = axios.post(`${API_BASE_URL}/auth/refresh`, {}, { withCredentials: true })
      .then((res) => {
        const data = adaptSessionPayload(res.data); // a no-op on the legacy server's answer
        setAccessToken(data.token);
        return data; // { token, user, session } — AuthContext's boot check needs `user`, the 401 retry path below only needs `token`
      })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

client.interceptors.response.use(
  (res) => res,
  async (err) => {
    const originalRequest = err.config;
    const status = err.response?.status;
    const url = originalRequest?.url || '';
    const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/refresh') || url.includes('/auth/unlock') || url.includes('/auth/verify-otp') || url.includes('/auth/pin-login') || url.includes('/auth/change-password');
    const code = errorCode(err);

    // The screen is locked (idle too long): hold this request until the password/PIN unlocks it, then repeat it.
    if (status === 403 && code === 'SESSION_LOCKED' && originalRequest && !originalRequest._lockRetried && !isAuthEndpoint && handlers.onLocked) {
      originalRequest._lockRetried = true;
      try { await handlers.onLocked(); } catch { return Promise.reject(err); }
      return client(originalRequest);
    }

    // A risky action needs the password typed again: ask, then repeat the action.
    if (status === 403 && code === 'REAUTH_REQUIRED' && originalRequest && !originalRequest._reauthRetried && handlers.onReauth) {
      originalRequest._reauthRetried = true;
      try { await handlers.onReauth(); } catch { return Promise.reject(err); }
      return client(originalRequest);
    }

    if (status === 401 && originalRequest && !originalRequest._retried && !isAuthEndpoint) {
      originalRequest._retried = true;
      try {
        const { token } = await performRefresh();
        originalRequest.headers.Authorization = `Bearer ${token}`;
        return client(originalRequest);
      } catch (refreshErr) {
        const ended = errorCode(refreshErr) === 'SESSION_EXPIRED';
        clearSessionAndRedirect(ended ? 'You were signed out because the session ended. Please sign in again.' : undefined);
        return Promise.reject(err);
      }
    }

    if (status === 401 && !isAuthEndpoint) {
      clearSessionAndRedirect();
    }
    return Promise.reject(err);
  }
);

export default client;

// The backend error contract is { error: { code, message } }. Use this
// everywhere instead of reading err.response.data.error directly (that's
// now an object, not a string — reading it raw renders "[object Object]").
export function getErrorMessage(err, fallback = 'Something went wrong.') {
  return err?.response?.data?.error?.message || fallback;
}

// 2.1 — lets a caller check specifically for "you must change your
// password first" (see middleware/auth.js) without string-matching a
// human-readable message.
export function isPasswordChangeRequired(err) {
  return err?.response?.data?.error?.code === 'PASSWORD_CHANGE_REQUIRED';
}
