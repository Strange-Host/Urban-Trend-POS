# Urban Trends POS: system documentation

What the system does and how it is built, as it stands today. For the rules the code is held to (and the tests that hold
it there) see `ARCHITECTURE.md`. To get it running, see `SETUP.md`. For what changed and when, see `CHANGES.md`. For the
side-rail layout and the screens built with it, see `docs/redesign/README.md`.

A point-of-sale and stock system for one retail shop that also sells online: a till, stock control across a main store and
outlets, online and phone orders with delivery and courier settlement, money tracking (M-Pesa, cards, cash held by staff,
expenses), a small CRM, and staff attendance and payroll.

---

## 1. Roles and permissions

Four roles. What a person may do is decided by permissions; each role starts with a default set, and an admin can change an
individual's set (see "Optional modules" for the switch that allows that).

| Role (`users.role`) | Is | Lands on |
|---|---|---|
| `admin` | the owner | Dashboard |
| `manager` | runs the shop day to day | Dashboard (with `reports.view`) |
| `cashier` | works the till, orders and leads | the Start screen (or the till, if they chose that in the account menu) |
| `store` | the storekeeper: receives and counts stock, no till | Catalog |

Permissions are defined once, in `backend/src/config/permissions.js` (name, group, label, default roles), checked on the API
by `requirePermission(...)` and in the app by `can(...)`. The same names gate menu items, tabs and tiles, so a screen never
offers something the API would refuse.

| Group | Permissions |
|---|---|
| Sales | `sales.void`, `sales.void_request`, `leads.intake_routes` |
| Orders | `orders.pull_online`, `orders.inspect`, `orders.resolve_dispute`, `couriers.manage` |
| Stock | `products.manage`, `products.propose`, `products.approve`, `products.view_cost`, `inventory.adjust`, `stock.receive`, `stock.transfer`, `stock.count`, `stock.review`, `shopify.sync` |
| Money | `expenses.manage`, `expenses.approve`, `payments.manage`, `payments.refund`, `payments.refund_request`, `payments.reconcile`, `approvals.review`, `requisitions.approve`, `atrisk.view`, `cashsessions.view`, `couriers.settle`, `couriers.pay`, `custody.manage` |
| Team | `payroll.view`, `staff.view`, `attendance.view`, `attendance.review` |
| Reports | `reports.view`, `reports.forecast` |
| Messaging | `sms.view` |

Defaults worth knowing: cashiers may ask for a void (`sales.void_request`) and submit stock counts (`stock.count`); storekeepers
may receive, transfer and count stock and propose new products; everything that decides, approves, reconciles or sees buying
prices is admin and manager. Settings, Staff and the Activity log are admin only and cannot be delegated.

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 22 or newer (`engines` in the root `package.json`) |
| API | Express 4, plain REST, `zod` 4 validation, `helmet`, `cors`, `express-rate-limit`, `compression` |
| Database | SQLite through `better-sqlite3` (synchronous, WAL, one file, `data/urban_trends.db`); raw SQL, no ORM |
| Auth | short-lived access token (JWT) plus a rotating, revocable refresh token; `bcryptjs` for passwords and PINs |
| Frontend | React 19, Vite 8, `react-router-dom` 7, Tailwind CSS 4 |
| Data in the app | `@tanstack/react-query` for server data; `zustand` for the cart, the offline sale queue and connection state |
| Tests | `vitest` on both sides (`supertest` for the API, Testing Library for the app); `oxlint` for lint |
| Types | JSDoc checked by `tsc` (a dev tool only) on the API layer and the hooks. Nothing is compiled from TypeScript. |
| Integrations | Shopify and WooCommerce (catalog and orders), M-Pesa and KCB (payments), Zettatel (SMS), SMTP (email) |

One deployable: `npm start` at the repository root runs migrations, optionally seeds, then starts the API, which also serves the
built frontend (`frontend/dist`).

---

## 3. Backend

```
backend/src/
  server.js          boots the app, starts the background jobs, handles shutdown
  app.js             middleware, route mounting, static frontend, 404, error handler
  config/            db, env, cors, limits, permissions, and one file per outside service
  db/                baseline.js + schema.sql (migration 0001, frozen), migrations/NNNN_*.sql, migrator.js, migrate.js, seed.js
  routes/            one file per resource: the guards (role, permission, module, rate limit) and nothing else
  controllers/       parse the request, call a service, shape the response. Never touch the database
  services/          the business rules and every SQL statement; transactions live here
  validation/        zod schemas for request bodies
  middleware/        auth, validate, requireModule, errorHandler, webhook auth, alertOnChange
  utils/             money, ApiError, auditLog, paginate, storeTime (the shop clock), logger, passwordPolicy, ...
  integrity/         the checks behind `npm run integrity` and the nightly job
  ledger/            order reference numbers
backend/scripts/     integrity-check, restore-backup, disable-2fa, import-delivery-areas
backend/tests/       the API suite; tests/characterization/ pins the money paths and the rules in ARCHITECTURE.md
```

**Request lifecycle.** `authenticate` verifies the access token and sets `req.user` (`id`, `role`, `storeId`, `name`);
`requirePermission` / `requireRole` / `requireModule` decide whether the route is open to this person; `validate(schema)` checks
the body; the controller calls a service; the service runs the transaction; the response is `{ data }` (lists add paging
fields) and failures are `{ error: { code, message } }` from the single error handler. Almost every query is scoped to
`req.user.storeId`.

**Lists** take `?page=` and `?limit=` (default 25, never more than 100). **Rate limits** (`config/limits.js`): sign-in 20 per 15
minutes (counted in the database, so a restart does not reset it), checkout 120 per 5 minutes, payment webhooks 300 per 5, manual
sync 20 per 15, and a blanket 600 per 5 for everything else. The others count in memory.

**Background jobs** (started in `server.js`; each one catches its own errors so a bad row cannot take the server down):

| Job | Every | Does |
|---|---|---|
| Backups | 6 hours local, 24 hours off-site | verified copies; see "Backups" |
| Nightly integrity | nightly | on-hand equals the ledger, order and payment totals agree; failures alert admins |
| Unconfirmed order sweep | 15 minutes | cancels cash-on-delivery orders past their confirmation window |
| Telesales rebalance | 15 minutes | moves leads and orders off people who are not clocked in (the "10:00 rule", unplanned absences) |
| SMS outbox | 30 seconds | sends queued messages with retry and expiry |
| Notification sweeps | 15 minutes | lead follow-ups due, products at their reorder level, expiring stock; prunes old notices |
| Live sync | every minute | asks each connected Shopify or WooCommerce store what changed (webhooks are the fast path) |
| Reconciliation check | 24 hours | logs inventory drift (the repair is manual) |

---

## 4. Data model

SQLite, more than 80 tables, 31 triggers. Created by `db/schema.sql` (frozen as migration `0001`) and the numbered files in
`db/migrations/`. Rules that hold everywhere:

- **Money is whole cents** in `INTEGER` columns (comments say "smallest KES subunit, never float"). No `REAL` money.
- **Timestamps are UTC.** Reports and "today" use the shop's calendar day (see "Dates and the shop clock").
- **Stock is a ledger.** `inventory_movements` only ever gains rows (`stock.service` is the one writer, see `ARCHITECTURE.md`);
  `inventory.quantity` is a cache that must equal the sum of the ledger, and `npm run integrity` and the nightly job check that.
  Triggers also refuse a movement that would take stock below zero.
- **Settled records are not edited.** Triggers refuse updates and deletes on locked payroll, courier statements and collections,
  custody records, delivery fee receipts, costs and adjustments, and commissions; a mistake is fixed by a reversal row with its own
  reason.
- **Soft delete** (`is_active` or `deleted_at`) wherever history could point at the row.
- **Every mutation is logged** to `staff_logs` through `utils/auditLog.js`.

| Area | Tables |
|---|---|
| Core | `stores`, `users`, `user_permissions`, `settings`, `categories`, `products`, `suppliers` |
| Stock | `inventory`, `inventory_movements`, `stock_receipts`, `stock_receipt_items`, `stock_receipt_drafts`, `stock_issues`, `stock_transfers`, `stock_transfer_items`, `stock_counts`, `stock_count_items`, `requisitions`, `requisition_items` |
| Till and shifts | `sales`, `sale_items`, `payments`, `cash_sessions`, `shift_handovers`, `petty_cash_topups`, `approval_requests`, `customers` |
| Orders and delivery | `orders`, `order_items`, `order_status_history`, `commissioned_orders`, `assignment_moves`, `couriers`, `package_fees`, `delivery_areas`, `delivery_settlements`, `delivery_fee_receipts`, `delivery_fee_verifications`, `delivery_costs`, `delivery_adjustments`, `courier_costs`, `courier_payouts`, `rider_payouts`, `rider_payout_items`, `payout_items`, `org_collections`, `org_statements`, `org_statement_lines`, `custody_records` |
| Payments and integrations | `payment_records`, `payment_notifications`, `stk_push_requests`, `payment_gateway_credentials`, `income_sources`, `income_source_webhooks`, `webhook_events`, `shopify_staging_products`, `sms_credentials`, `sms_outbox` |
| CRM | `leads`, `lead_activities`, `lead_status_history`, `lead_form_routes` |
| Spending | `expenses`, `expense_categories` |
| People and payroll | `staff_attendance`, `end_of_day_reviews`, `employee_agreements`, `employee_documents`, `payroll_runs`, `payroll_items`, `payroll_item_lines`, `payroll_adjustments` |
| Security and system | `auth_sessions`, `refresh_tokens`, `otp_challenges`, `rate_limits`, `security_events`, `staff_logs`, `notifications`, `integrity_runs`, `sales_forecasts` |

Two "payments" exist on purpose: `payments` are the tenders taken at the till for one sale (split payments supported), and
`payment_records` are money movements recorded against orders and suppliers (layaway, refunds, outgoing payments). Both are
integer cents.

Schema changes are numbered migrations, never edits to `schema.sql`. See `ARCHITECTURE.md` and
`backend/src/db/migrations/README.md`.

---

## 5. API

Every route is under `/api`. The route file for each prefix holds its guards; `config/permissions.js` holds what each permission
means. Public endpoints are the sign-in routes, the lead-intake form (secret-protected), and the signed webhooks and payment
callbacks.

| Prefix | What it covers |
|---|---|
| `/auth` | sign in (password, cashier PIN, SMS code), refresh, logout, unlock, change password, your sessions and "sign out others" |
| `/products`, `/categories` | the catalog; staff propose new products and a manager approves them |
| `/inventory` | stock levels, low stock, a product's movements, manual adjustment, drift check and repair |
| `/stock` | receipts and their drafts (`/receipts/drafts`), costing of receipts, issues, batches and recalls, alerts, transfers, counts |
| `/suppliers`, `/stores` | suppliers; branches |
| `/sales` | till checkout, sales history, void, thermal receipts (`/:id/receipt.escpos`), `/discount-limit` |
| `/approvals` | void and refund requests waiting for a decision |
| `/orders`, `/customers` | online and phone orders: create, confirm, dispatch, returns and inspection, payments, disputes; a customer's order history |
| `/couriers`, `/delivery`, `/delivery-areas` | couriers and what they are owed, each delivery's fee against its costs, delivery areas and rates |
| `/custody` | shop cash held by staff until it is deposited |
| `/payments`, `/payment-reconciliation` | recorded payments and refunds; matching unmatched M-Pesa to orders |
| `/integrations/payments`, `/integrations/payments/callbacks`, `/settings/payment-gateways` | provider webhooks and callbacks (M-Pesa, KCB), gateway credentials |
| `/expenses`, `/petty-cash` | spending and petty cash |
| `/cash-sessions`, `/shift` | till shifts (open, close, summary); `/shift/handover` |
| `/leads`, `/telesales`, `/integrations/leads` | the CRM, lead and order distribution (`/telesales/rebalance`), the website form |
| `/requisitions`, `/attendance`, `/end-of-day`, `/payroll`, `/employees` | the HR and back-office module (off by default): internal requests, clock-in, the day's review, payroll, onboarding |
| `/reports` | dashboard figures, reports, forecasts, profit and loss |
| `/income-sources`, `/integrations/shopify`, `/integrations/webhooks` | connected Shopify and WooCommerce stores: connect, test, sync, review staged products, inbound webhooks |
| `/sms`, `/notifications` | SMS delivery and retry; each person's in-app notices |
| `/users` and `/staff` (same router), `/staff-logs` | staff accounts; the activity log |
| `/settings`, `/system`, `/security`, `/modules`, `/backups` | business settings; server address and email; security rules and alerts; the optional-module switches; backups and restore |

---

## 6. Frontend

```
frontend/src/
  main.jsx, App.jsx     the router (every route below), providers
  api/                  client.js (token, refresh, errors) and endpoints.js (one object per resource); typed
  hooks/                stores and shared hooks: useCartStore, useOfflineQueue, useConnectionStatus, useAttentionQueue, ...; typed
  context/              AuthContext (user, can, hasRole), UIContext (toast, dialogs), ...
  components/           shared UI; Layout.jsx and shell/ are the app shell; till/ is the till's pieces
  pages/                one file per route; pages with several parts keep them in a folder beside them (orders/, stock/, settings/, ...)
  utils/                small helpers, including the cashier's choice of home (cashierHome.js)
```

**State.** Server data goes through React Query; forms and screen state are local; the cart, the offline queue and connection
state are `zustand` stores (the cart and the queue are saved in the browser). Pages call `api/endpoints.js` directly; there is
no frontend service layer.

**One layout.** `Layout.jsx` is the app shell: a rail and top bar from 1024px wide, a bottom bar below it, workspace tabs over each
page, and the page itself in an `<Outlet />`. `navItems.js` decides what each role sees. What the layout has, and what is still to be
checked in a browser, is in `docs/redesign/README.md`.

**Offline.** The till keeps working without a connection: products and categories are cached, a sale that cannot be sent is
queued with its own id (so a retry can never double-post) and replayed when the connection returns; the till shows what is
waiting and anything the server refused.

**Routes** (`App.jsx`; a route also needs the permission shown, and some need an optional module):

| Route | Page | Who |
|---|---|---|
| `/` | each role's home | everyone |
| `/start`, `/terminal` | Start screen, the till | admin, manager, cashier |
| `/dashboard`, `/reports` | Today / Dashboard, Reports | `reports.view` |
| `/orders`, `/leads`, `/sales`, `/approvals` | Orders, Leads, Sales history, Approvals | orders and leads: admin, manager, cashier |
| `/catalog`, `/stock`, `/shopify-sync` | Catalog, Stock control, Shopify sync | catalog: admin, manager, store; sync: `shopify.sync` |
| `/finance`, `/money-at-risk`, `/reconciliation` | Finance (payments, expenses, cash sessions, couriers, delivery rates, custody), Money at risk, Reconciliation | admin, manager; the last two need `atrisk.view`, `payments.reconcile` |
| `/requisitions`, `/attendance`, `/attendance/end-of-day`, `/payroll`, `/employees` | HR module pages | need the HR module; payroll `payroll.view`; employees admin |
| `/staff`, `/staff-logs`, `/settings` | Staff, Activity log, Settings | admin |
| `/security`, `/change-password`, `/login` | account pages | everyone |

`/products`, `/categories`, `/inventory`, `/expenses` and `/payments` redirect to the page that now holds them.

---

## 7. Main features, by area

**Till and sales.** Checkout takes cash, M-Pesa, card or a split of them; prices include VAT and checkout adds no tax. A cashier
can apply a sale-wide discount up to their cap (`max_discount_percent`, where 0 means no cap). Voids and refunds are requests that a
manager approves (`/approvals`); large ones also alert the admins. Receipts print through the browser, or through the print bridge
for paper cut and the cash drawer (`print-bridge/README.md`).

**Stock.** Stock lives at the main store and at outlets; outlets are supplied by transfers. Receiving puts stock in through the
ledger, with batch and expiry. A storekeeper's buying price is never stored or shown; a manager or admin costs the batch afterwards
(`/stock/receipts/awaiting-cost`). A delivery can be saved as a draft first and finished later; a draft touches no stock until it is
submitted. Transfers and counts need a reviewer's approval; every movement lands in the ledger with who and why.

**Online and phone orders.** Orders are pulled from Shopify and WooCommerce or taken by phone, are confirmed, dispatched with a
courier (asking whether the customer paid the delivery fee), delivered or returned, and a returned parcel is inspected (good back to
stock, damaged written off). Each dispatched order has one delivery settlement: the fee actually collected against the courier's
fee and approved extra costs. Couriers and courier organizations are paid from their payables.

**Money.** M-Pesa and KCB payments arrive by webhook or callback; one that matches no order waits in Reconciliation until someone
matches it. "Money at risk" is the manager's daily list of where money or goods may be going missing. Shop cash held by staff is
tracked until deposited. Expenses and petty cash need approval.

**CRM and distribution.** Leads (website form, phone, walk-in) move through a fixed set of states with a history; new leads and
orders are shared among the cashiers who are clocked in, and moved off anyone who is not.

**People.** Attendance, the end-of-day review, payroll (draft, then locked runs; commission only on secure money), onboarding with
documents and agreements. This is the HR module and is off until an admin switches it on.

**Reports.** Dashboard and Today, sales by channel, trends, payment methods, top products, unpaid parcels, profit and loss,
forecasts and budgets, and the inventory value.

---

## 8. Security and sessions

- **Sessions.** Each sign-in is a session with a short-lived access token (15 minutes by default, `ACCESS_TOKEN_EXPIRES_IN`) and a
  rotating refresh token that can be revoked (30 days, `REFRESH_TOKEN_EXPIRES_DAYS`). A copied
  refresh token that is replayed ends the whole session and alerts the admins. People see their signed-in devices on the Security page
  (`/security`) and can sign out all the others; an admin can sign someone out everywhere.
- **Screen lock.** After an idle time (set per role by an admin on the Security page) the server refuses everything except unlocking, with the
  password or, for cashiers, the PIN. "Keep me signed in on this device" lasts to the role's maximum; otherwise a session ends when
  the browser closes and is capped at 12 hours.
- **Confirm it's you.** Refunds, voids, stock adjustments, staff changes and changes to settings or integrations ask for the password
  again if it has not been typed recently.
- **Lockout.** Five wrong passwords or PINs in a row lock the account for 15 minutes (both are configurable; PIN and password are
  counted separately). An admin can lift a lock from the staff menu.
- **Passwords.** At least 12 characters for admins and managers, 8 (not only digits) for cashiers; common passwords, simple runs and
  passwords containing the person's name are refused. Two-factor sign-in by SMS is available when the control extras module is on.
- **Alerts to admins** (bell and the Security page; urgent ones also by email when email is set up): lockouts, replayed sign-ins,
  refunds and voids over KES 3,000 (configurable), and similar.
- **Secrets.** SMS and payment-gateway credentials are encrypted in the database with `ENCRYPTION_KEY`; keep that key with the data.
- **Cross-origin.** With `CORS_ORIGIN` unset, the browser is accepted from this machine and the shop's own network; set it to lock
  the API to specific addresses.

---

## 9. Optional modules (Settings > Business > Optional modules)

Two switches, both off on a new or upgraded install. Off hides the menu items and screens and closes the matching API (404
`MODULE_DISABLED`); nothing is deleted.

- **HR and back office:** attendance and clock-in, payroll, onboarding, requisitions. While it is off nobody clocks in, so new leads
  and orders go to every active cashier and the 10:00 reassignment pauses. Staff and the Activity log stay available.
- **Control extras:** per-person permission overrides, two-factor set-up, order disputes, and the "prepay only" and "watch" badges.
  Overrides and two-factor that were set earlier keep being enforced while it is off; only changing them is closed. To remove
  two-factor for someone while it is off, switch it on, change it, or run `npm run disable-2fa`.

Code: `services/modules.service.js`, `middleware/requireModule.js`, `routes/modules.routes.js`; in the app `hooks/useModules.js`.

---

## 10. Dates and the shop clock

The database stores every timestamp in UTC. Reports, the dashboard, attendance and late fees, and follow-up dates use the shop's
calendar day (`backend/src/utils/storeTime.js`), default `Africa/Nairobi` (UTC+3), so a sale rung up at 1:30 am counts for today. Set
`STORE_TIMEZONE` (an IANA name) only if the shop is elsewhere. Report `from` and `to` are inclusive whole days as `YYYY-MM-DD`;
anything else is a 400.

---

## 11. Configuration, backups and operation

**Configuration.** Nothing needs configuring to start: the first run writes `backend/.env` with its own random secrets. Server
address, email and most other settings are set in the app (Settings > Server, Email, Business). `backend/.env.example` lists the
environment variables that still exist and what each is for; the ones that matter most are `DATABASE_PATH`, `ENCRYPTION_KEY`,
`BACKUP_PASSPHRASE`, `CORS_ORIGIN`, `APP_BASE_URL`, `TRUST_PROXY_HOPS`, `STORE_TIMEZONE` and `PORT`.

**Backups.** A verified local copy every 6 hours (the last 28 kept, in `data/backups/`); an encrypted off-site copy by email every
24 hours once email is set up and `BACKUP_PASSPHRASE` is set. The schedule is remembered in the database, so a restart or redeploy
never skips one. A copy is also taken before any pending migration runs. Failures show in the bell and by email. Restore from Settings
> Backups, or check a downloaded copy on your own machine with `backend/scripts/restore-backup.js` (see `SETUP.md`).

**Integrity.** `npm run integrity` (and the nightly job) checks that on-hand equals the ledger for every product and store, and that
order and payment totals agree.

**Logs.** `data/logs/`, rotated (`LOG_MAX_MB`, `LOG_MAX_FILES`, `LOG_LEVEL`).

**Running in production** (supervisor, restart behaviour, Cloudflare in front, deployment on Railway): `SETUP.md`.
