# Urban Trends POS — Audit: Bugs, Risks & Recommendations

Reviewed the full backend (config/controllers/services/routes/middleware/
utils/schema) and full frontend (pages/components/context/api/hooks) line
by line, including a dedicated follow-up review of the Shopify/WooCommerce
connection module specifically. Findings below, split into **bugs** (things
that are actually wrong) and **recommendations** (things that work but
could be better). Severity is my judgment as reviewer, not a formal CVSS
score.

---

## 1. Bugs found

### 1.1 — FIXED: voiding an online sale would corrupt inventory
**Severity: High. Status: Fixed during this audit.**

`POST /api/sales/:id/void` restocks every line item of the sale. It had no
check on `source_type`. A Shopify/WooCommerce sale pulled in by
`salesSync.service.js` never decremented local inventory in the first place
(by design — the platform owns its own stock). Voiding one anyway would
**add** stock that was never subtracted, silently inflating on-hand counts.
The frontend hides the Void button for non-local sales, but nothing stopped
a direct API call (a bug report, a script, a future feature) from doing it
anyway.

**Fix applied** in `sales.service.js`: `voidSale()` now throws a 409 if
`sale.source_type !== 'local'`, with a message pointing the caller to
refund/cancel on the originating platform instead.

### 1.2 — FIXED: login failed on correct credentials with different letter casing
**Severity: High (real users hit this in practice). Status: Fixed.**

`auth.controller.js`'s login lookup was `WHERE email = ?` — SQLite's default
string comparison is case-sensitive (BINARY collation), and `users.email`
had no `COLLATE NOCASE`. Mobile keyboards commonly auto-capitalize the
first letter of a text input unless the field explicitly disables it, so
typing a perfectly correct email on a phone (`admin@...` → autocapitalized
to `Admin@...`) silently failed the lookup and returned "Invalid email or
password" — a message that reads as a wrong password when the actual cause
is unrelated to the password at all. Confirmed by reproduction: identical
password, only the email casing differed.

**Fix applied**: login now does a case-insensitive match
(`WHERE lower(email) = lower(?)`, plus trims whitespace), `users.controller.js`
normalizes email to lowercase on both create and update so stored data can't
drift into case-mismatched duplicates either, and `Login.jsx`/`Staff.jsx`
now set `autoCapitalize="none"` on email fields to stop the mobile keyboard
from doing this in the first place. Also fixed the Login page's error
handling, which previously showed the exact same "check your details"
message for a real wrong-password 401 *and* for a request that never
reached the server at all (network/CORS failure) — the two are now
distinguished, since silently conflating them was its own source of "I know
my password is right" confusion independent of the casing bug.

### 1.3 — FIXED: cross-store product key collisions could silently overwrite or block imports
**Severity: was Low-medium as originally flagged; reassessed to High for WooCommerce during a
follow-up review — this is a real-world scenario for the multi-WooCommerce-store setup the
original feature request asked for, not just a theoretical edge case. Status: Fixed.**

Originally flagged as an unscoped match in `shopify.service.js`'s product
matching logic — no awareness of which connected store a given id came
from. `products.shopify_variant_id` was a single global `UNIQUE` column
shared by every Shopify and WooCommerce source. Re-assessed during a full
review of the Shopify/WooCommerce connection module: Shopify's ids are
large and effectively globally unique across all shops in practice, but
WooCommerce's are small, sequential, per-site integers — two different
WooCommerce sister stores very plausibly both have a "product 15".
Reproduced directly: staging and approving product 15 from two different
WooCommerce sources hit the `UNIQUE` constraint and blocked the second
store's import outright.

**Fix applied**, in two parts:
1. Added `products.income_source_id`, and scoped every existing-product
   match query (in both `shopify.service.js` and `wooProducts.service.js`)
   by it, alongside the existing SKU-fallback match (which stays
   deliberately unscoped — the same physical product listed on more than
   one connected store should still map to one local product if it shares
   a SKU).
2. Replaced the single-column `UNIQUE` on `shopify_variant_id` with a
   composite unique index scoped by `(income_source_id, shopify_variant_id)`
   — required a full table rebuild since SQLite can't alter an inline
   `UNIQUE` constraint in place. This surfaced a real migration hazard
   during testing: naively renaming `products` out of the way and recreating
   it fresh silently rewrites every OTHER table's foreign key clause
   (`inventory`, `sale_items`, `inventory_movements`, `requisition_items`,
   etc.) to point at the renamed-away copy instead of the new table —
   verified this empirically before shipping, not just assumed from docs,
   since a documented `legacy_alter_table` pragma that's supposed to prevent
   this turned out not to in the SQLite version bundled with `better-sqlite3`
   here. Fixed by building the new table under a temporary name first (old
   `products` untouched throughout), copying data across, then dropping the
   old table and renaming the temp one into place — verified against a
   realistic pre-existing database (multiple products, inventory, sale
   items, inventory movements, requisition items) with `PRAGMA
   foreign_key_check` reporting zero violations after, and confirmed
   idempotent (safe to run again without re-triggering).

Re-ran the original reproduction after the fix: two WooCommerce sources both
importing their own "product 15" now correctly create two separate local
products instead of colliding or blocking.

### 1.3b — Approval doesn't route inventory to the income source's configured store (unfixed)
**Severity: Low today — only matters once someone has multiple physical POS locations
mapped to different income sources, which isn't the current real-world setup.**

Found while reviewing the fix above: `income_sources.store_id` exists
specifically to represent "which POS location this channel's stock
attributes to," but `shopify.service.js`'s `approve()` always receives
`req.user.storeId` (the approving staff member's own store) from the
controller — never the income source's own configured `store_id`. For a
single-store setup (the only one actually in use right now) this is
invisible, since there's only one store to attribute to either way. Worth
deciding explicitly — should approval prefer the income source's configured
store when set, falling back to the approver's own store — rather than
fixing unilaterally, since it touches the approval flow shared by every
platform and deserves a real product decision rather than a drive-by change.

### 1.4 — Inconsistent currency representation across tables
**Severity: Low today, medium as a long-term footgun.**

Two different conventions coexist:
- `products.sell_price`, `sales.total`, `payments.amount` → `REAL`, whole
  currency units (e.g. `1044.00`).
- `expenses.amount`, `payment_records.amount` → `INTEGER`, subunits/cents
  (e.g. `104400`), explicitly commented as intentional in `schema.sql`.

Both are internally consistent and correctly handled by their respective
frontend pages (`Expenses.jsx`/`Payments.jsx` multiply by 100 on save,
divide on display) — this isn't broken today. But it means **any future
code that touches both conventions without checking which table it's
reading has a 100x bug waiting to happen**, and float currency math
(`REAL`) accumulates rounding error over enough line items — the checkout
tolerance of `0.01` currently absorbs it, but it's a latent risk on carts
with many odd-tax-rate items.

**Recommendation:** standardize on integer subunits everywhere (the
`expenses`/`payment_records` pattern), including `products`, `sales`,
`sale_items`, and `payments`. This is a breaking schema change — plan it as
a dedicated migration, not a drive-by fix.

### 1.5 — `payments.amount` validation comment doesn't match enforcement
**Severity: Cosmetic.**

`payments.controller.js`'s inline comment says *"amount must be a positive
integer (smallest currency subunit)"*, but the actual check is `!amount ||
amount <= 0` — it accepts floats (`150.5` passes). The `INTEGER` column type
in SQLite is only a type *affinity*, not an enforced constraint, so a float
gets silently stored (SQLite will actually coerce/truncate depending on
value). Either enforce `Number.isInteger(amount)` in the controller, or fix
the comment to describe what's actually enforced.

### 1.6 — `cash_sessions` table exists but is entirely unused
**Severity: Low (dead weight, not a runtime bug).**

The schema defines a full cash-drawer open/close/reconciliation table
(`opening_amount`, `closing_amount`, `expected_amount`), and `sales` even
has a `cash_session_id` foreign key ready to use — but there is no
controller, route, or frontend page for it anywhere. `sales.service.js`
accepts a `cashSessionId` param and stores it if passed, but nothing ever
passes one. Either finish the feature (see Recommendations §3.1) or remove
the unused schema to reduce confusion.

### 1.7 — Demo credentials hardcoded into the Login page UI
**Severity: Medium if this ever ships to production as-is.**

`Login.jsx` renders `demo: admin@urbantrends.com / ChangeMe123!` directly on
the sign-in screen, unconditionally. Fine for local dev/demo; a real
security problem if this build is ever deployed publicly without removing
it. Should be gated behind `import.meta.env.DEV` or removed before any
production deploy.

### 1.8 — RESOLVED (by a later architecture change): unauthenticated OAuth routes
**Originally flagged as low severity; no longer applicable.**

This originally flagged `GET /api/income-sources/:id/shopify/oauth/start`
and `/callback` as intentionally unauthenticated (required for a browser
redirect flow, which can't carry a Bearer header) but somewhat probeable
since IDs are sequential integers. The Shopify connection flow was later
switched from the authorization-code/redirect grant to the **client
credentials grant** — a plain server-to-server exchange with no browser
redirect at all — specifically because it's the flow Shopify's own docs
recommend for an app you built for your own store. Those two routes no
longer exist; every `/api/income-sources/*` route now sits behind normal
Bearer auth like the rest of the API, which removes this finding entirely
rather than just mitigating it.

---

### 1.9 — FIXED: upstream Shopify/WooCommerce auth failures forced the user's own logout
**Severity: High (directly hit in practice, not theoretical). Status: Fixed.**

The frontend treats *any* `401` response, from *any* endpoint, as "your
login session expired" and force-logs the user out (`client.js`'s axios
interceptor — reasonable behavior in general). Five separate places in the
backend were passing a third-party's own `401` (Shopify or WooCommerce
rejecting a bad/expired token) straight through as *our* API's response
status: the legacy sync endpoint, the three newer Settings-driven sync/test/
connect endpoints, and the OAuth token exchange. The browser can't tell
"Shopify's token is bad" apart from "your JWT expired" when both look
identical over the wire — so a bad Shopify token silently logged the
current user out of the whole app. Reproduced directly against a real
Shopify 401.

**Fix applied**: added `utils/upstreamError.js`, a shared helper used at all
five call sites, that always responds `502 Bad Gateway` for upstream
failures — correct semantics ("we tried to reach a dependency and it
failed") and doesn't collide with anything the frontend treats specially.
The real upstream status and error body are preserved in the message text.
Verified: a failing sync now returns 502 with the real Shopify error
message, and a follow-up request with the same token still succeeds — the
user's session is no longer a casualty of a bad third-party credential.

### 1.10 — FIXED: Income Sources / Settings allowed `manager` tokens further than the UI ever does
**Severity: Medium (defense-in-depth gap on real third-party secrets, not directly exploited).**

The frontend gates the entire Settings page (general config + income
sources) to `admin` only. The backend routes for `/api/income-sources` and
`GET /api/settings` allowed `admin` **or** `manager`. Since nothing in the
UI ever reaches these endpoints with anything less than an admin token,
this was a live-but-unused excess-privilege surface: a manager-role JWT
used directly against the API (not through the app's own UI) could read
and, for income sources, fully create/edit/delete/connect/sync — including
credentials for real third-party stores. Fixed by restricting both routers
to `admin`-only, matching the frontend's actual access model. Verified with
a real manager account: now correctly `403` on both, admin unaffected.

### 1.11 — FIXED: pasting a full URL into "Shop domain" / "Site URL" silently broke every request
**Severity: Medium (an easy, natural mistake — the exact text most people would copy from
their browser's address bar).**

Neither field was normalized before being stored. `shop_domain` gets used
directly as `https://${shop_domain}/...` — pasting the URL as shown in a
browser (`https://xyz.myshopify.com/admin/`, protocol and trailing slash
included) produces a malformed `https://https://xyz.myshopify.com/admin//...`
at request time, surfacing as a confusing DNS/connection error rather than
a clear validation message. Fixed by normalizing on save: strips protocol,
any path, and trailing slashes for `shop_domain`; for WooCommerce's
`site_url`, additionally re-adds a canonical `https://` since that field is
used as a real base URL rather than a bare domain. Verified against both
directions of the mistake (full URL with protocol for Shopify, bare domain
with no protocol for WooCommerce).

### 1.12 — FIXED: catalog "sync" was actually a one-time import — later Shopify/WooCommerce changes never reached the live product
**Severity: High — this was the core capability gap in the whole module. Status: Fixed.**

Found while investigating a report that the integration "wasn't working to
its full capabilities." Traced it to the staging upsert logic: once a
staged product was approved, `review_status` stayed `'approved'` forever on
every subsequent sync — the SQL only ever flipped `'rejected'` rows back to
`'pending'` for another look, never `'approved'` ones. Combined with
`approve()` refusing to run against anything but a `'pending'` row, this
meant: change a price, name, or stock count in Shopify (or WooCommerce)
*after* the first import, click "Sync" as many times as you like, and
nothing ever reaches the live catalog or even surfaces anywhere for review.
The staging row silently absorbed the new data and went nowhere. What
looked like an ongoing two-way-ish sync was actually a one-time import with
no way to push updates through afterward.

**Fix applied**, split by what kind of change it is:
- **Price / name / barcode changes** — the same review-before-it-touches-
  the-catalog philosophy used everywhere else in this system now applies
  consistently here too: an approved row whose data has genuinely changed
  (`match_status = 'update'`) flips back to `'pending'` and reappears in
  the review queue, same as a rejected row does. The live product is left
  untouched until a human explicitly re-approves it.
- **Stock quantity** — treated differently on purpose: it's a fact, not a
  judgment call the way price is, and a stale count is the most
  operationally damaging kind of drift (overselling something actually out
  of stock, or blocking a sale for something actually available). Already-
  approved products now get their stock quantity synced immediately on
  every pull, with a normal `inventory_movements` audit entry, no
  re-approval gate.

Verified end-to-end against the real `pullFromShopify` function (not just
the SQL in isolation) with a mocked Shopify response: approved a product,
re-synced with a changed price/name/stock, confirmed the staging row went
back to `pending`, confirmed stock updated immediately with a movement
logged, confirmed the live product's name/price stayed untouched until
re-approval, then confirmed re-approving correctly applied the change.
Applied identically to the WooCommerce sync path. The existing Shopify Sync
review page needed no changes — it already distinguished "New product" from
"Updates existing," so a re-surfaced change displays correctly without any
frontend work.



## 2. Architecture-level risks (not bugs, but worth flagging)

### 2.1 No automated tests anywhere
There is no test framework configured in either `package.json`, and no test
files exist. Every verification in this project (including every fix in
this document) has been manual, ad-hoc `curl`/reproduction-script testing.
For a system that handles money and inventory, this is the single
highest-leverage gap — see Recommendations §3.

### 2.2 `inventory.quantity` is a cache with no reconciliation job
`inventory.quantity` is maintained by incrementing/decrementing it inline
with every mutation (`sale`, `void`, `adjust`, `requisition approve`, and
now the Shopify/WooCommerce stock auto-sync), each paired with an
`inventory_movements` row. There's no periodic or on-demand job that
recomputes `quantity` from `SUM(inventory_movements.change_qty)` and flags
drift. If any code path ever updates one without the other, the two
silently diverge with no alarm.

### 2.3 Single SQLite file, single writer
`better-sqlite3` in WAL mode handles concurrent reads well, but writes are
serialized. Fine for one store's register + back office; will become a real
constraint if this scales to many concurrent registers or multiple stores
writing simultaneously. Not a bug at current scale — a scaling ceiling to
know about.

### 2.4 No refresh tokens / no server-side revocation
JWTs are signed with an 8h expiry and nothing else — there's no refresh
flow and no way to invalidate a token early (e.g., on password change, the
issued token for that user technically still works until it expires; same
for `resetPassword` and account deactivation — a currently-logged-in
deactivated user keeps a valid token until it naturally expires). Low risk
at small-team scale, real risk if this ever handles a larger or
higher-turnover staff.

### 2.5 Secrets stored in plaintext in the database
`income_sources.api_secret`, `.access_token`, `.consumer_key`,
`.consumer_secret` are stored as plain `TEXT` columns — never returned to
the browser (correctly), but not encrypted at rest either. Anyone with
filesystem access to `data/urban_trends.db` (or a backup of it) has every
connected store's live API credentials in the clear.

### 2.6 CORS still defaults to allow-everything if `CORS_ORIGIN` is unset
`app.js` now supports a comma-separated allowlist (added to support testing
from a phone on the same LAN alongside a regular browser), but the
fallback when `CORS_ORIGIN` is unset entirely is still to allow any origin.
Fine for local dev; if `CORS_ORIGIN` is ever left unset in a real
deployment, this opens the API to any origin. Should fail loudly (or
default to `false`) instead of silently allowing everything in production.

### 2.7 Rate limiting only covers `/api/auth`
Every other endpoint — including checkout, Shopify/WooCommerce sync
triggers (which make outbound calls to a third-party API and could be
abused to hammer it), and report queries — has no rate limiting. Low
priority for an internal tool behind auth, but worth knowing if this is
ever exposed more broadly.

## 3. Recommended additions / upgrades

Roughly ordered by leverage (impact vs. effort), not strict priority.

### 3.1 Finish or remove the cash session feature
The schema is ready (`cash_sessions`, `sales.cash_session_id`). Finishing it
would let a cashier open a drawer with a starting float, have every sale
during their shift auto-attach, and close out with an expected-vs-actual
reconciliation — a genuinely useful register feature that's half-built
already. Estimated effort: one controller/route/service + one frontend page
+ a "session open?" gate on the POS Terminal.

### 3.2 Automated tests
Start with the two riskiest transactional flows: `sales.service.js`
(checkout math, stock validation, void) and `requisitions.service.js`
(approval transaction) — then the Shopify/WooCommerce sync flows, given how
much subtle state (staging review status, matched-product routing, stock
auto-sync) those now carry. A handful of integration tests against a
throwaway SQLite file would catch regressions like several of the bugs in
§1 before they ship. `vitest` or `jest` + `supertest` would be a natural
fit given the existing stack.

### 3.3 Inventory reconciliation job/endpoint
An admin-triggered (or scheduled) job that recomputes each product's stock
from `inventory_movements` and reports any row where the cached
`inventory.quantity` disagrees. Cheap to build, high value as a safety net
given §2.2 above.

### 3.4 Encrypt income source secrets at rest
At minimum, encrypt `api_secret`/`access_token`/`consumer_key`/
`consumer_secret` with a key from an env var (e.g. AES-256-GCM via Node's
`crypto`) before writing to SQLite, decrypting only when building an API
client. Removes the "anyone with the DB file has every store's live
credentials" exposure in §2.5.

### 3.5 Move receipt/notification delivery out of "returned once in-band"
Password reset (`resetPassword`) and, longer-term, receipts/low-stock
alerts currently have no delivery channel — everything is either shown
once in the UI or not sent at all. Wiring up email (or SMS, given the
phone-centric CRM) for password resets specifically would close a real
usability gap (an admin has to relay the temp password out-of-band today).

### 3.6 Route approval to the income source's configured store
See §1.3b — `approve()` always attributes new stock to the approving
staff member's own store rather than the income source's own configured
`store_id`. Worth an explicit decision (prefer the source's store when set,
fall back to the approver's) once multi-location setups are actually in
play; invisible today with only one store connected.

### 3.7 Currency representation unification
`products`/`sales`/`sale_items`/`payments` use `REAL` (float, whole
currency units); `expenses`/`payment_records` use `INTEGER` (subunits/
cents). Both are internally consistent today, but the split is a latent
100x-bug risk for any future code that touches both without checking which
convention it's reading, and float currency math accumulates rounding
error over enough line items. Worth migrating everything to integer
subunits before this handles meaningfully higher transaction volume.

### 3.8 Refresh tokens + revocation list
A short-lived access token (e.g. 15 min) plus a refresh token, or at
minimum a server-side "token version"/"password changed at" check on every
request, would close the gap in §2.4 — a deactivated or password-reset
account's old token should stop working immediately, not at natural expiry.

### 3.9 Structured logging & basic observability
`morgan` currently logs HTTP access lines to stdout; there's no structured
application logging (e.g. every Shopify/WooCommerce sync run, every failed
login, every void) and no metrics/health beyond the plain `/api/health`
liveness check. Worth adding before this runs unattended in production —
sync failures currently only surface if someone happens to look at the
Settings page.

### 3.10 Multi-currency support
`settings.business_currency` exists as a single global string, and every
amount field assumes one currency implicitly. Not urgent for a single-store
deployment; relevant the moment a second income source operates in a
different currency than the local register — a real possibility now that
multiple WooCommerce/Shopify sources are properly supported.

### 3.11 Variant support in the local catalog
`shopify.service.js`'s own comment notes: *"this POS has no variant concept
yet — 'Crew Tee, Blue, M' becomes its own SKU."* That's a reasonable
simplification for now, but it means size/color variants of the same
product are entirely separate `products` rows with no shared grouping,
which limits things like "show me total stock across all sizes of this
shirt" without a manual join on name prefix. Worth a proper `product_id` +
`variant_id` model if the catalog grows past a few hundred SKUs.

### 3.12 Frontend: shared UI primitives
Every CRUD page (`Categories`, `Expenses`, `Payments`, `Requisitions`,
`Staff`, `Products`) reimplements its own table/form/badge markup rather
than sharing components (unlike `Settings.jsx`'s `SectionCard`/`Field`
pattern, which is the exception, not the rule). Not a bug, just accumulating
duplication — worth factoring into a shared `components/` library
(`DataTable`, `FormField`, `StatusBadge`) if more CRUD pages get added.

## 4. What's already solid (worth naming, so future changes don't accidentally regress it)

- Every multi-step mutation that touches money or stock (`checkout`,
  `voidSale`, requisition `approve`, Shopify/WooCommerce product `approve`,
  sales sync) is wrapped in a `better-sqlite3` transaction — no partial-write
  states possible from a mid-operation crash.
- Soft-delete discipline is consistent (`is_active` / `deleted_at`) — nothing
  that could be referenced by a sale, requisition, or audit log is ever
  hard-deleted.
- The staged-review pattern (Shopify/WooCommerce product sync never touches
  `products` without a human approval step) is applied consistently and is a
  genuinely good design decision for a system where bad data import could
  silently corrupt a live catalog — reinforced, not weakened, by the fix in
  §1.12 (stock auto-syncs since it's a fact, but price/name changes still
  wait for a human).
- Every mutation in the CRM/requisitions/expenses/payments/staff modules
  writes an audit row (`staff_logs`) with a real before/after diff, not just
  "something changed."
- Error handling is centralized and consistent (`ApiError` → single
  `errorHandler` → `{ error: { code, message } }` everywhere, including
  translating raw SQLite constraint violations into a sane 409, and — since
  the fix in §1.9 — never leaking a third party's own HTTP status code as
  ours).
