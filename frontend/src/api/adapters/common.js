// Small pieces every adapter shares. An adapter's job is to make the new server look, to a page, exactly like the legacy one:
// same function names, same argument order, same response shapes. Pages should change by import path only.

/** Thrown (as a rejected promise) by a legacy call whose new-server counterpart is not built yet. Never silently falls back to the legacy backend. */
export class NotImplementedOnNewServer extends Error {
  constructor(name) {
    super(`${name} is not available on the new server yet.`);
    this.name = 'NotImplementedOnNewServer';
    // The shape pages already read errors from, so getErrorMessage() shows this instead of "[object Object]".
    this.response = { status: 501, data: { error: { code: 'NOT_IMPLEMENTED_ON_NEW_SERVER', message: this.message } } };
  }
}
/** A refusal made by the adapter itself (a missing choice, a payment route that no longer exists), shaped like a server error so pages show its message. */
export class AdapterError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'AdapterError';
    this.response = { status, data: { error: { code, message } } };
  }
}
export const notImplemented = (name) => () => Promise.reject(new NotImplementedOnNewServer(name));

/**
 * The legacy list shape: { data, page, pageSize, total, totalPages }. The new server pages by limit/offset and names its
 * rows by module ({ orders, total }); `usePager` and `fetchAll` only know the legacy shape.
 */
export function toLegacyPage(rows, total, { page = 1, pageSize = 50 } = {}) {
  const size = Math.max(1, Number(pageSize) || 50);
  return { data: rows, page: Number(page) || 1, pageSize: size, total, totalPages: Math.max(1, Math.ceil(total / size)) };
}

/** Legacy page/pageSize (or limit) in, the new server's limit/offset out. */
export function toLimitOffset({ page = 1, pageSize, limit } = {}) {
  const size = Math.max(1, Number(pageSize ?? limit) || 50);
  return { limit: size, offset: (Math.max(1, Number(page) || 1) - 1) * size };
}

const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k) => k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const mapKeys = (v, fn) => {
  if (Array.isArray(v)) return v.map((x) => mapKeys(x, fn));
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [fn(k), mapKeys(x, fn)]));
  return v;
};
/** The new server speaks camelCase; the legacy pages read snake_case. Deep, and only touches plain objects. */
export const snakeKeys = (v) => mapKeys(v, snake);
export const camelKeys = (v) => mapKeys(v, camel);

/** Applies `fn` to an axios response's data and returns the response, so callers still get { data, status, ... }. */
export const mapResponse = (promise, fn) => promise.then((res) => ({ ...res, data: fn(res.data) }));
