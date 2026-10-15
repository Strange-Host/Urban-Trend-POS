// Phase 3.3 — these were previously inline magic numbers scattered across
// ~10 files (app.js, several routes files, several controllers), each a
// plain object literal or a bare Math.min/Math.max call with no name
// attached to what the number meant or why it was chosen. Centralizing
// them here doesn't change any actual behavior (every value below is
// exactly what was already in place) — it just makes "why is checkout
// limited to 120 requests per 5 minutes and not something else" a single
// place to look, and a single place to change.

// windowMs / max for express-rate-limit. Tighter limits belong on
// endpoints an attacker can actually guess/brute-force their way through
// (login, PIN); webhook/sync endpoints get their own limits sized to
// realistic traffic rather than the general API ceiling.
const RATE_LIMITS = {
  GENERAL_API: { windowMs: 5 * 60 * 1000, max: 600 },   // app.js — the blanket ceiling for everything else
  LOGIN: { windowMs: 15 * 60 * 1000, max: 20 },          // auth.routes.js — login + PIN login share this
  SYNC: { windowMs: 15 * 60 * 1000, max: 20 },           // incomeSources.routes.js — manual Shopify/WooCommerce sync triggers
  CHECKOUT: { windowMs: 5 * 60 * 1000, max: 120 },       // sales.routes.js — POS checkout, higher than general since a busy register legitimately fires often
  WEBHOOK: { windowMs: 5 * 60 * 1000, max: 300 },        // paymentWebhooks.routes.js — KCB/M-Pesa can retry a delivery; this needs headroom for that
};

// Pagination — page/pageSize (older modules: products, sales, cash
// sessions, reports) and page/limit (newer modules, via utils/paginate.js)
// use different query-param names for historical reasons, but the same
// underlying default/max values, kept consistent here rather than each
// file picking its own.
const PAGINATION = {
  DEFAULT_PAGE_SIZE: 25,
  MAX_PAGE_SIZE: 100,
  // Reports default to a shorter "top N" list; still capped so a caller
  // can't request an unbounded aggregate scan of the whole sales history.
  REPORTS_DEFAULT_LIMIT: 10,
  REPORTS_MAX_LIMIT: 50,
  // top-products-by-channel specifically defaulted lower and capped
  // tighter than the other report endpoints before this refactor —
  // preserved as-is rather than unifying it, since collapsing it into
  // REPORTS_DEFAULT_LIMIT/MAX_LIMIT would silently change its behavior.
  TOP_PRODUCTS_BY_CHANNEL_DEFAULT_LIMIT: 5,
  TOP_PRODUCTS_BY_CHANNEL_MAX_LIMIT: 20,
  // cash sessions previously had a default but NO upper bound at all —
  // fixed here as part of this same pass (see cashSessions.controller.js):
  // an uncapped pageSize is a real, if minor, DoS surface (one request
  // asking for every cash session ever, in one query).
  CASH_SESSIONS_DEFAULT_PAGE_SIZE: 20,
};

module.exports = { RATE_LIMITS, PAGINATION };
