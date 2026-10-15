# Urban Trends POS — System Documentation

A full-stack point-of-sale system for a retail business: register checkout,
inventory, multi-channel sales (in-store + Shopify + WooCommerce), a small
CRM, requisitions, expenses, payments, staff management, and audit logging.

This document describes what the system **does** and how it's **built**.
See `AUDIT.md` for bugs found, risks, and recommended improvements.

---

## 1. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Backend runtime | Node.js + Express | REST API, no framework beyond Express |
| Database | SQLite via `better-sqlite3` | WAL mode, synchronous driver, single file (`data/urban_trends.db`) |
| Auth | JWT (`jsonwebtoken`) + `bcryptjs` | Bearer tokens, 8h expiry by default |
| Frontend | React 18 + Vite | SPA, no SSR |
| Routing | `react-router-dom` v6 | Client-side routing, one `ProtectedRoute` gate |
| Server state | `@tanstack/react-query` | All API data fetching/caching |
| Client state | `zustand` | Cart state only (`useCartStore`) |
| Styling | Tailwind CSS | Custom design tokens (ink/paper/surface/accent/success/danger) |
| Security middleware | `helmet`, `cors`, `express-rate-limit`, `compression` | Rate limiting scoped to `/api/auth` |
| External integrations | Shopify Admin REST API, WooCommerce REST API | Both via `axios` |

No ORM — all queries are raw SQL through `better-sqlite3`'s prepared
statements. No test suite exists (see `AUDIT.md`).

---

## 2. Architecture

### 2.1 Backend layout

```
backend/src/
  app.js                 Express app: middleware, route mounting, 404, error handler
  server.js               Boots app.js on PORT (default 4000)
  config/
    db.js                  better-sqlite3 connection, WAL + foreign_keys pragmas
    shopify.js              Shopify Admin API client factory + fetch helpers
    woocommerce.js           WooCommerce REST API client factory + fetch helpers
  db/
    schema.sql              Full DDL — every table, index, CHECK constraint
    migrate.js               Applies schema.sql + backfills columns on existing DBs
    seed.js                  Creates default store, admin user, sample catalog
  middleware/
    auth.js                  authenticate() (JWT verify) + requireRole(...roles)
    errorHandler.js          Central error → { error: { code, message } } contract
  controllers/               One per resource — thin, calls services or queries directly
  services/                  Business logic with transactions (sales, requisitions, leads, sync)
  routes/                    One per resource — auth/role gates live here
  utils/
    ApiError.js               Typed HTTP error class
    asyncHandler.js            Wraps async route handlers → forwards to errorHandler
    paginate.js                Shared page/limit/offset parsing (25 default, 100 max)
    auditLog.js                logStaffAction() — writes to staff_logs on every mutation
    phone.js                   Phone normalization for lead dedup
```

Every controller follows the same shape: `asyncHandler(async (req, res) => {...})`,
reads `req.user` (set by `authenticate`) for `id` / `role` / `storeId`, and
returns `{ data: ... }` (or a paginated envelope — see §5). Errors are thrown
as `ApiError(status, message, details?)` and caught centrally.

### 2.2 Frontend layout

```
frontend/src/
  main.jsx                  ReactDOM root, wraps App in QueryClientProvider
  App.jsx                    Router: all routes, wrapped in AuthProvider + Layout
  context/AuthContext.jsx     login()/logout()/hasRole(), persists token+user in localStorage
  components/
    Layout.jsx                 Sidebar nav (role-filtered) + top bar + outlet
    ProtectedRoute.jsx          Redirects to /login if unauthenticated; 403 page if wrong role
  api/
    client.js                  Axios instance, attaches Bearer token, 401 → redirect to /login
    endpoints.js                One object per resource, thin wrappers over client calls
  hooks/useCartStore.js        Zustand store for the POS terminal's in-progress sale
  pages/                       One file per route (see §4 for the full list)
```

State pattern: every page uses React Query for server data (`useQuery` /
`useQueryClient().invalidateQueries`), local `useState` for form/UI state,
and calls `endpoints.js` functions directly — there's no separate "service"
layer on the frontend.

### 2.3 Request lifecycle

1. Browser attaches `Authorization: Bearer <jwt>` (from `localStorage['ut_token']`) via an axios interceptor.
2. `authenticate` middleware verifies the JWT, sets `req.user = { id, role, storeId, name }`.
3. `requireRole(...)` (where present) checks `req.user.role`.
4. Controller runs, using `req.user.storeId` to scope almost every query to the caller's store.
5. Response is `{ data }` or a paginated envelope; errors are `{ error: { code, message } }`.
6. A `401` anywhere clears local storage and hard-redirects to `/login` (see `client.js`).

---

## 3. Data model

18 tables, all SQLite with `CHECK` constraints standing in for enums (no
Postgres-style native enum type). Soft-delete (`deleted_at` or `is_active`)
is used everywhere sales history or audit trails could reference the row —
nothing user-facing is ever hard-deleted except categories (which block
deletion if in use) and leads/requisitions/expenses/payment_records
(soft-deleted).

| Table | Purpose | Key relationships |
|---|---|---|
| `stores` | Physical/POS locations, multi-location ready | referenced by nearly everything via `store_id` |
| `users` | Staff accounts — also *is* the Staff module | `role` ∈ admin/manager/cashier |
| `settings` | Key/value POS-wide config (business name, tax defaults, receipt footer) | — |
| `income_sources` | Connected Shopify/WooCommerce stores | optionally maps to a `store` |
| `categories` | Self-referencing product categories | — |
| `products` | Catalog | optional Shopify linkage columns |
| `inventory` | Cached qty per (product, store) | source of truth is `inventory_movements` |
| `inventory_movements` | Append-only stock ledger | `reason` ∈ sale/restock/adjustment/return/void/requisition |
| `customers` | Optional sale attribution, loyalty-ready | — |
| `cash_sessions` | Cashier shift open/close reconciliation | *(schema exists; no controller/route uses it yet — see AUDIT.md)* |
| `sales` | Sale header | `source_type` ∈ local/shopify/woocommerce |
| `sale_items` | Line items | — |
| `payments` | Per-sale checkout payments (supports split) | distinct from `payment_records` below |
| `shopify_staging_products` | Review-before-publish staging for both Shopify and WooCommerce catalog pulls | — |
| `staff_logs` | Write-only audit trail for every mutation across CRM/requisitions/expenses/payments/staff | — |
| `leads` / `lead_activities` / `lead_status_history` | CRM | state machine enforced in `leads.service.js` |
| `requisitions` / `requisition_items` | Internal stock requests | approval auto-adjusts inventory |
| `expense_categories` / `expenses` | Outgoing spend tracking | amounts stored as integer subunits (cents) |
| `payment_records` | Layaway/partial customer payments + outgoing supplier payments | **not** the same table as `payments` |

### 3.1 Two separate "payments" concepts (important)

- **`payments`** — created automatically by checkout (`sales.service.js`), one row per tender in a sale. Amounts are `REAL` (whole currency units, e.g. `1044.00`).
- **`payment_records`** — created explicitly via the Payments page/API, for layaway/partial payments against a sale or outgoing supplier payments. Amounts are `INTEGER` (subunits/cents, e.g. `104400`).

These are intentionally different tables serving different purposes, but the
**inconsistent currency representation** (float vs. integer-cents) between
them is a real design wrinkle — see `AUDIT.md` §2.

### 3.2 Migrations

There is no numbered migration system. `schema.sql` is idempotent
(`CREATE TABLE IF NOT EXISTS`), and `migrate.js` additionally backfills a
short list of columns (`ADDITIVE_COLUMNS`) added after the original tables
existed, via `ALTER TABLE ... ADD COLUMN`, so `npm run migrate` is safe to
re-run against an existing database. New columns added in the future must be
added to that list by hand, or `schema.sql`'s new indexes will fail against
an old table shape.

---

## 4. Frontend routes

All routes below live under `<Layout>` and are wrapped in `<ProtectedRoute
roles={[...]}>`; the sidebar (`Layout.jsx`) only shows links the current
user's role can access.

| Route | Page | Roles | Purpose |
|---|---|---|---|
| `/login` | `Login.jsx` | public | Email+password sign-in |
| `/` | `POSTerminal.jsx` | admin, manager, cashier | Register checkout — search/scan, cart, tender |
| `/dashboard` | `Dashboard.jsx` | admin, manager | Analytics: revenue by channel, daily trend, payment mix, top products |
| `/catalog` | `Catalog.jsx` (tabs: `Products.jsx`, `Categories.jsx`) | admin, manager | Product catalog CRUD, stock adjustments (folded in from the old Inventory page), and category CRUD, as tabs on one page |
| `/sales-history` | `SalesHistory.jsx` | admin, manager, cashier | All transactions, filterable by channel |
| `/shopify-sync` | `ShopifySync.jsx` | admin, manager | Shared Shopify/WooCommerce catalog review/approve queue — SKU and category are editable per row before approving; SKU auto-assigns (sequential) if left blank |
| `/settings` | `Settings.jsx` | admin | Business config, income source (Shopify/WooCommerce) connections, and database backups |
| `/leads` | `Leads.jsx` | admin, manager, cashier | CRM — cashiers see only their assigned leads |
| `/requisitions` | `Requisitions.jsx` | admin, manager, cashier | Internal stock requests + approval queue |
| `/finance` | `Finance.jsx` (tabs: `Payments.jsx`, `Expenses.jsx`) | admin, manager | Payment records and expense tracking, as tabs on one page |
| `/staff` | `Staff.jsx` | admin | Staff accounts (create/edit/deactivate/reset password) |
| `/staff-logs` | `StaffLogs.jsx` | admin | Audit trail viewer |

---

## 5. API reference

Base path: `/api`. All routes except `/auth/*` and the Shopify OAuth
start/callback pair require `Authorization: Bearer <jwt>`. Response shape is
either `{ data }` or, for list endpoints using the shared paginator,
`{ data, page, limit, total, totalPages }`.

### Auth — `/api/auth` (rate-limited: 20 req / 15 min)
| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/login` | public | `{ email, password }` → `{ token, user }` |
| POST | `/pin-login` | public | `{ userId, pin }` — fast register login |
| GET | `/me` | any | Current user |

### Products — `/api/products`
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/` | any | `?q=&category_id=&page=&pageSize=` |
| GET | `/barcode/:code` | any | Scanner lookup |
| GET | `/:id` | any | |
| POST | `/` | admin, manager | Also seeds a 0-qty inventory row |
| PUT | `/:id` | admin, manager | |
| DELETE | `/:id` | admin, manager | Soft delete (`is_active = 0`) |

### Categories — `/api/categories` — admin/manager write, any read
Standard CRUD; delete blocked (409) if any active product references it.

### Inventory — `/api/inventory`
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/` | any | Per-store stock levels |
| GET | `/low-stock` | any | `quantity <= reorder_level` |
| GET | `/:productId/movements` | any | Ledger, last 100 |
| POST | `/adjust` | admin, manager | `{ product_id, change_qty, reason }`, transactional |

### Sales / POS — `/api/sales`
| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/` | any | Checkout — validates stock, tax, payment total; fully transactional |
| GET | `/` | any | `?from&to&cashier_id&source_type&income_source_id&includeAllChannels=1` |
| GET | `/:id` | any | Full sale + items + payments |
| POST | `/:id/void` | admin, manager | Restocks — **blocked for non-local sales** (see AUDIT.md, fixed) |

### Reports / Analytics — `/api/reports`
| Method | Path | Notes |
|---|---|---|
| GET | `/sales-summary` | Totals for a date range, one store |
| GET | `/top-products` | Best sellers, one store |
| GET | `/inventory-value` | Cost/retail stock value, one store |
| GET | `/sales-by-channel` | **All stores/channels** — revenue, tx count, avg basket per channel |
| GET | `/sales-trend` | Daily revenue, split by channel, for charting |
| GET | `/payment-methods` | Totals by tender method |
| GET | `/top-products-by-channel` | Top sellers per channel |

All admin/manager only.

### Settings — `/api/settings` — admin/manager read, admin write
`GET /` → key/value config (with defaults). `PUT /` → merge-update.

### Income sources — `/api/income-sources`
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET `/:id/shopify/oauth/start` | outside Bearer auth | Browser redirect → Shopify authorize |
| GET `/:id/shopify/oauth/callback` | outside Bearer auth | Exchanges code, redirects to frontend |
| GET / POST / PATCH / DELETE `/` | admin, manager | CRUD (secrets never returned, only `has_*` booleans) |
| POST `/:id/test` | admin, manager | Cheap read-only ping |
| POST `/:id/sync-products` | admin, manager | Pulls catalog into `shopify_staging_products` |
| POST `/:id/sync-sales` | admin, manager | Pulls orders into `sales` |

### Legacy Shopify sync — `/api/integrations/shopify` — admin/manager
Env-var-based single-store sync, predates income sources. `POST /sync`,
`GET /staging`, `POST /staging/:id/approve|reject`, `POST /staging/approve-all`.

### CRM — `/api/leads` — admin, manager, cashier (cashiers scoped to own leads)
`GET /stats`, `GET /`, `POST /`, `GET /:id`, `PATCH /:id`, `DELETE /:id`,
`POST /:id/activities`, `PATCH /:id/status` (enforces the state machine —
new → contacted → rescheduled/converted/cancelled).

### Requisitions — `/api/requisitions` — create/list: all 3 roles; approve/reject: admin/manager
`GET /`, `POST /`, `GET /:id`, `PATCH /:id/approve`, `PATCH /:id/reject`.
Approval is a single transaction: line items, inventory, and the movements
ledger commit atomically.

### Expenses — `/api/expenses` — admin, manager only
`GET /categories`, `POST /categories`, `GET /summary`, `GET /`, `POST /`,
`GET /:id`, `PATCH /:id`, `DELETE /:id` (soft).

### Payments (layaway/supplier) — `/api/payments` — admin, manager only
`GET /summary`, `GET /`, `POST /`, `POST /:id/refund`.

### Staff — `/api/staff` (and `/api/users`, same controller)
Read: admin, manager. Write (create/update/delete/reset-password): admin only.

### Staff logs — `/api/staff-logs` — admin only
`GET /stats`, `GET /` — read-only audit trail viewer.

---

## 6. Feature walkthroughs

### 6.1 Authentication & roles
Two login paths: email+password (`Login.jsx`) and PIN (`pin-login`, for a
shared register — not currently wired to a frontend page). A PIN is 4-6 digits,
never an obvious one (1234, 0000, 1111, 2345...), and **only cashier accounts can sign in with it** -
admins and managers always use email + password. Startup removes the old seeded `1234` PIN from admin accounts. Three roles:
`admin` > `manager` > `cashier`, enforced per-route via `requireRole`, not a
hierarchical check — each route lists its own allowed roles explicitly.

### 6.2 POS Terminal (`/`)
Product grid with search-as-you-type, a barcode-scan input (Enter-terminated
fast keyboard input), and a running cart (`useCartStore`, Zustand). Checkout
posts `{ items, payments }` to `POST /api/sales`; the backend independently
recomputes subtotal/tax/total from current product prices and stock levels
(never trusts client-computed totals except for the payment-amount match
check) and rejects if insufficient stock or payment mismatch (>0.01
tolerance). Each item decrements `inventory` and writes an
`inventory_movements` row (`reason='sale'`) inside the same transaction.

### 6.3 Inventory
Per-store cached `quantity` in `inventory`, always changed alongside an
`inventory_movements` row — the movements table is the real audit trail;
`inventory.quantity` is a derived cache (never independently reconciled —
see AUDIT.md). Manual adjustments require a reason (`restock` /
`adjustment` / `return`); `sale`, `void`, and `requisition` reasons are only
ever written by their respective flows, not exposed on the manual-adjust
endpoint.

### 6.4 Sales History & multi-channel tracking
Every sale — local or online — lands in the same `sales` table, tagged by
`source_type`. The list defaults to the cashier's own store (unchanged
original behavior); `?includeAllChannels=1` (used by the Sales History page)
shows everything, since online orders don't belong to a specific cashier's
shift. Each sale shows a channel badge (Local / Shopify / WooCommerce) and,
for online sales, which specific connected store it came from.

### 6.5 Analytics Dashboard
Pulls from the `/api/reports/*` endpoints described above: total revenue
split local vs. online, a dependency-free daily stacked-bar trend chart
(plain CSS/SVG, no charting library), revenue-by-channel table, payment
method mix, and top products broken out per channel.

### 6.6 Settings & Income Sources
`Settings.jsx` has two sections:
- **General** — business name/currency/phone/address/tax default/receipt
  footer/low-stock default, stored in the `settings` key/value table.
- **Income sources** — add any number of Shopify or WooCommerce stores.
  Shopify: shop domain + API key/secret (from the Shopify Dev Dashboard,
  required since Shopify retired direct-token custom apps on Jan 1, 2026) +
  either OAuth connect or a pasted legacy token. WooCommerce: site URL +
  REST API consumer key/secret. Each source can be tested, synced (products
  and/or sales independently), and disconnected (soft — sales history
  survives).

Secrets (`api_secret`, `access_token`, `consumer_key`, `consumer_secret`)
never round-trip to the browser — the API only ever reports boolean
`has_access_token` / `has_consumer_key` flags.

### 6.7 Shopify OAuth flow
`shopifyOAuth.service.js` implements the standard authorization-code grant:
`buildAuthorizeUrl` (with a stored CSRF `state`) → full browser redirect to
Shopify → `exchangeCodeForToken` on callback → access token stored on the
`income_sources` row. This is a real page navigation (`<a href>` in the UI),
not a fetch call, because Shopify needs to redirect the actual browser tab.

### 6.8 Product sync (Shopify + WooCommerce)
Both platforms funnel into the same `shopify_staging_products` table
(historical name; now generic), tagged by `platform` + `income_source_id`.
Nothing reaches the live `products` table until a human approves a staged
row (`shopify.service.js` / legacy path, generalized to also accept
WooCommerce rows via `wooProducts.service.js`). Shopify variants and
WooCommerce product variations are both flattened to one staging row each
("Crew Tee — Blue / M" style naming). Matching against existing products is
by `shopify_variant_id` first, then SKU.

### 6.9 Sales sync (Shopify + WooCommerce)
`salesSync.service.js` pulls orders (Shopify: `/orders.json`, WooCommerce:
`/orders`) since the source's `last_sales_synced_at` (or a 30-day fallback
on first sync), and inserts them directly into `sales`/`sale_items`/
`payments` — no staging/review step, since these are historical facts, not
catalog data to curate. Key rules:
- **Inventory is never touched.** The originating platform already manages
  its own stock; double-decrementing would be wrong.
- **Unmatched SKUs auto-create a placeholder product** rather than dropping
  the line item, so nothing vanishes from analytics.
- **Deduplication** via a unique index on `(income_source_id,
  external_order_id)` — re-running a sync is safe.
- Each income source gets its own virtual `stores` row (reusing the
  existing multi-location model) so `sales.store_id` stays meaningful.
- The importing admin's user id is used as `cashier_id` (schema requires
  `NOT NULL`; there's no real cashier for an online order).

### 6.10 CRM (Leads)
A small state machine (`new → contacted → rescheduled/converted/cancelled`,
enforced in `leads.service.js`) with a duplicate-phone check on create
(phone numbers normalized to their last 9 digits to absorb country-code
formatting differences). Status changes auto-log both a
`lead_status_history` row and a synthetic `status_change` activity — staff
never manually log that. Cashiers are scoped to leads assigned to them at
both the controller (list/get/update) and service (status change ownership
check) layers.

### 6.11 Requisitions
Staff request stock (`POST /requisitions`); manager/admin approve
(optionally adjusting per-line `quantity_approved` down from what was
requested) or reject with a reason. Approval is one `better-sqlite3`
transaction: requisition status, each line's approved quantity, the
`inventory` row, and an `inventory_movements` entry (`reason='requisition'`)
all commit together or not at all.

### 6.12 Expenses & Payment Records
Both use integer-subunit (cents) amounts and soft delete. Expenses are
categorized (categories are a lookup table, not a hardcoded enum) and
scoped to a date range distinct from `created_at`. Payment records track
either an incoming payment against a sale (layaway/partial) or an outgoing
supplier payment, with a `refund` action that flips status without deleting
the original row (audit trail over net-zero convenience).

### 6.13 Staff & Staff Logs
Staff *is* `users` — no parallel table, since JWTs already carry a user id
and a second identity table would risk drift. Deactivation is soft
(`is_active = 0`); an admin cannot deactivate their own account. Password
reset generates a random temporary password returned once, in-band (there's
no email/SMS delivery — see AUDIT.md). Every mutation across CRM/
requisitions/expenses/payments/staff writes a `staff_logs` row via
`logStaffAction()`, storing a computed before/after diff (or a full
snapshot on delete).

---

## 7. Running the system

```bash
# Backend
cd backend
cp .env.example .env        # edit JWT_SECRET at minimum
npm install
npm run migrate             # idempotent — safe on fresh or existing DB
npm run seed                # creates default store + admin login
npm run dev                 # API on :4000

# Frontend
cd frontend
npm install
npm run dev                 # Vite dev server on :5173
```

Default login after seeding: `admin@urbantrends.com` / `ChangeMe123!` (no PIN is created; PIN login is for cashiers only).

Key env vars (see `.env.example` for the full annotated list):
`JWT_SECRET`, `DATABASE_PATH`, `CORS_ORIGIN`, `BACKEND_PUBLIC_URL` /
`FRONTEND_PUBLIC_URL` (for the Shopify OAuth redirect), and the legacy
`SHOPIFY_SHOP` / `SHOPIFY_ACCESS_TOKEN` / `SHOPIFY_API_VERSION` trio.


### Dates, "today" and the shop clock
The database stores every timestamp in UTC. Reports, the dashboard, attendance/late fees and follow-up dates
all use the **shop's calendar day** (`backend/src/utils/storeTime.js`), default `Africa/Nairobi` (UTC+3), so a
sale rung up at 1:30 am counts for today. Set `STORE_TIMEZONE` (an IANA name) only if the shop is elsewhere.
Report `from`/`to` are inclusive whole days in `YYYY-MM-DD`; anything else is rejected with 400.


### Optional modules (Settings > Business > Optional modules)
Two switches, both **off** on a new or upgraded install; an admin turns on what the shop uses.
Off hides the menu items and screens **and** closes the matching API (404 `MODULE_DISABLED`); nothing is deleted.
- **HR & back office:** Attendance/clock-in, Payroll, Onboarding (employee documents/agreements), Requisitions.
  While off nobody clocks in, so new leads and orders are shared out to every active cashier instead of only
  those clocked in (and the "10:00 rule" reassignment pauses). Staff and the Activity log stay available.
- **Control extras:** per-person permission overrides, two-factor sign-in set-up, order disputes, and the
  "prepay only / watch" badges. Overrides and two-factor that were set earlier **keep being enforced** while
  off - only changing them is closed. To remove 2FA for someone while this is off: switch it on, change it,
  or use `npm run disable-2fa`.
Code: `services/modules.service.js`, `middleware/requireModule.js`, `routes/modules.routes.js`; frontend `hooks/useModules.js`.
