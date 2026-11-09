# Architecture rules

The structure the code is held to, and the test that fails when someone drifts from it. This is the document to read before
changing how things are organised. For what the system does, see `DOCUMENTATION.md`; for how a change is made safely, the last
section.

The rules exist because each one was a place where the system had gone wrong or could go wrong silently: stock changed from ten
files, SQL scattered through controllers, one 939-line migration file, floating-point money, pages of a thousand lines. Each is now
a convention **and a test**, so the structure cannot drift back without someone noticing.

---

## The rules

| # | Rule | Enforced by |
|---|---|---|
| 1 | **Services own SQL.** A controller parses input, calls a service and shapes the response. It never uses the database. | `backend/tests/characterization/thinControllers.test.js` fails on `db.prepare`, `db.exec`, `db.transaction`, `db.pragma`, or importing the db handle in `controllers/` |
| 2 | **`stock.service` owns stock.** It is the only file under `backend/src/` that inserts into or updates `inventory` or `inventory_movements`. | `tests/characterization/stockWriters.test.js` (empty allow-list; migrations and the first-run seed are exempt) |
| 3 | **Migrations are numbered and never edited.** Every schema change after the baseline is a new `NNNN_what_it_does.sql`. | `tests/migrations.test.js`, and the runner itself, which refuses to start on an edited or missing file |
| 4 | **Money is integer cents, parsed and split by `utils/money.js`.** No `REAL` money, no `Math.round(x * 100)`, no float arithmetic on amounts. | `tests/characterization/moneyAndErrors.test.js`, `tests/money.test.js` |
| 5 | **One error type.** Anything a request can reach throws `ApiError`; the single error handler understands only that. | `moneyAndErrors.test.js` (no new `Error` subclass, no hand-built status errors) |
| 6 | **On-hand equals the ledger.** `inventory.quantity` always equals the sum of `inventory_movements` for the product and store. | `npm run integrity`, the nightly job, `tests/integrity.test.js`, and the characterization tests that assert it after every stock path |
| 7 | **Pages stay under 400 lines**, with one `PageHeader` and one `Tabs` style, in one shell (`components/Layout.jsx`). A page with several parts keeps them in a folder beside it. There is no layout flag and no second layout. | `frontend/src/pageStructure.test.js` (an exception must be listed with a reason and a ceiling, and must be removed when no longer needed; it also fails if the old flag or sidebar code comes back) |
| 8 | **The API layer and the hooks are typed.** | `npm run typecheck` in CI (see "Frontend") |

The tests and the type check run in CI (`.github/workflows/ci.yml`: the whole backend suite; the frontend's lint, type check, tests
and build). A change that breaks a rule fails the build, and the fix is to follow the rule, not to loosen the test.

---

## Backend

```
routes  ->  controllers  ->  services  ->  database
guards      parse, call,     the rules,      (better-sqlite3,
            shape            the SQL,        synchronous)
                             transactions
```

- **Routes** hold the guards (`requirePermission`, `requireRole`, `requireModule`, rate limits, `validate(schema)`) and nothing else.
- **Controllers** are `asyncHandler(async (req, res) => ...)`: take what they need from `req`, call a service with explicit
  parameters (`{ user, params, query, body }`), choose the status code, send the result. They keep their handler names and exports
  so `routes/` does not change when a service does.
- **Services** hold every query and every transaction. A multi-step change is one `db.transaction`.
- A service that needs another service which needs it back creates a circular `require`. Where this has happened, the inner
  `require` sits inside the function with a comment (`sales.service` and `approvals.service`); do the same rather than restructure.

### Stock

`stock.service.applyMovement` is the single door. It checks the shortfall, writes the ledger row, and updates the cached quantity in
one step. Callers keep their own error wording through an optional `shortfall({ onHand, hadRow, needed })` hook, so the till and
dispatch can say "Stock changed while you were ringing this up" and manual adjust can say something else.

Beside it: `ensureRow` (a zero row for a new product, no ledger row), `resetCache` (the repair job's cache-only correction, no ledger
row, by design), `inventoryRow`, `quantityOf`. Receipts, issues, transfers, counts, requisitions, orders and the till all reach stock
only through these. Documents (`stock_receipts`, `stock_transfers`, `stock_counts`) are written by their own services; they are
records of what happened, not the stock itself.

A **draft receipt** is deliberately not a receipt: it is a saved request body in `stock_receipt_drafts`, so it cannot affect stock.
Submitting runs the ordinary receive and deletes the draft in one transaction.

Some ledger rows carry no `reference_type` (till sales, voids, requisitions, manual adjustments); receipts, issues, transfers, counts
and orders set it. The characterization tests pin today's values. Filling them in later is a visible change to the movements list.

### Migrations

`db/baseline.js` plus `db/schema.sql` are migration `0001`, frozen and idempotent, so any older database is brought up to date by
it. Everything after is `db/migrations/NNNN_what_it_does.sql`, four digits, no gaps, each run once inside a transaction and recorded
in `schema_migrations` with a checksum. `db/migrate.js` is the entry point (`npm run migrate`, `npm start`, the tests); `--status`
lists applied and pending without changing anything. How to add one: `backend/src/db/migrations/README.md`.

The runner stops the server, changing nothing, when: an applied file was edited (checksum differs); an applied file is missing from
the code (the database is newer than the application); there is a gap, a duplicate number or a badly named file; or a new file is
numbered below one already applied. A failing migration keeps nothing of itself and the error names the backup.

Before anything pending runs on a database that already holds data, a `VACUUM INTO` copy is written to
`<data dir>/backups/pre-migration-<time>-to-<version>.db` (owner-only, the last 10 kept, listed in Settings so it can be restored).
Rollback is "restore that copy", not per-migration down scripts; that is deliberate for SQLite.

### Money and errors

`utils/money.js`: `toCents` and `requireCents` (decimal text to cents; blank is 0, rubbish is a 422), `formatMoney`, `percentToBp`,
`percentOf`, `inclusivePart` (the VAT inside a gross figure), `roundDiv`, and `allocate` / `split` (shares that always add back to
the total). Display formatting belongs to the frontend. A percentage of an amount is computed in integers (basis points), never as a
float. Hours, backup sizes and ratios shown in a report are not money and may be floats.

`ApiError(status, message, details?, code?)` is the only error type. The handler turns it into `{ error: { code, message } }`.

### Tests

`backend/tests/` is the API suite (each file runs against its own temporary database, never `data/`).
`tests/characterization/` is the safety net for the money and stock paths: sale, void, adjust, receipt, issue, transfer, count,
requisition, order create, dispatch, cancel, returns, order payments and refunds, courier settlement. Each asserts concrete numbers
(totals, payment rows, the exact ledger rows, the cached quantity, and that the cache equals the ledger). If you intend to change
what one of those paths does, it shows up as a diff there; if you do not, a failure there is the bug.

---

## Frontend

- **`api/`** is the only place requests are made: `client.js` (token, refresh, error messages, downloads) and `endpoints.js` (one
  object per resource). Pages call `endpoints.js`; they do not call `axios` themselves.
- **Types are JSDoc, checked by `tsc` as a dev tool.** No file is converted to TypeScript, there is no build step and nothing runs in
  production. `frontend/jsconfig.json` turns on `checkJs`; `npm run typecheck` (`scripts/typecheck.mjs`) fails only on errors inside
  the typed folders: `src/api/`, `src/hooks/`, `src/utils/cashierHome.js`. `tsc` follows imports, so it also
  reports errors in untyped files they import; the script ignores those. To type another folder, fix its errors, then add it to `SCOPE`
  in the script and to `include` in `jsconfig.json`. Request bodies are `Record<string, any>` on purpose: the backend's zod schemas own
  the field shapes.
- **Pages** compose shared pieces (`PageHeader`, `Tabs`, `Sheet`, `Skeleton`, `EmptyState`, `Pager`, `Picker`, `StatCard`) and keep
  their data and handlers; a piece they split off takes props and holds no data of its own.
- **Colours and type** are tokens in `index.css`; components do not hard-code hex values (the print layouts use plain black and white).
- **One shell.** `components/Layout.jsx` is the only layout: a rail and top bar on large screens, a bottom bar below 1024px, the page
  in an `<Outlet />`. `components/navItems.js` says what each role sees and which workspace each page belongs to; `components/shell/`
  holds the pieces and `railModel.js` the rules, as plain tested functions. There is no layout flag: the redesign's `ut_ui` flag and
  the old sidebar were removed at cutover, and `utils/legacyStorage.js` clears the keys they saved. A change to the shell ships to
  everyone at once, so it is checked per role (`components/Layout.test.jsx`, `WorkspaceStrips.test.jsx`) and in a browser first.
- **`useSlidingPill`** survives, used only by the Dashboard's date-range switch. It is not shell code.

---

## Making a change safely

| To | Do |
|---|---|
| Add an endpoint | route (guard + `validate`) -> controller (thin) -> service (SQL, transaction) -> an entry in `frontend/src/api/endpoints.js` with JSDoc param types -> a test |
| Change the schema | a new numbered migration; try `npm run migrate -- --status`, then `npm run migrate`, then `npm run integrity` on a copy of the live database first |
| Change stock | go through `stock.applyMovement`; run `npx vitest run tests/characterization` |
| Handle an amount | integer cents; `utils/money.js` for parsing, percentages and splits |
| Add a permission | `config/permissions.js` (name, group, label, default roles); guard the route with it; use `can('...')` in the app; add it to the table in `DOCUMENTATION.md` |
| Add a page | a route in `App.jsx`, an entry in `components/navItems.js` (with its `workspace`), `PageHeader` for the title, under 400 lines |
| Add an optional feature switch | `services/modules.service.js` (`KEYS`), `requireModule` on the routes, `useModules` in the app |

Before a deploy that changes the database: back up the live database, run the migration on a copy, run `npm run integrity`, and roll
out at a quiet time of day.

---

## Known limits

These are deliberate or not yet decided, not unknown bugs.

- **One SQLite file, one process.** Right for one shop on one server. Revisit only if the business needs several branches writing
  from different servers at once, a volume SQLite cannot handle, or proper double-entry accounting. Do not run two instances: the
  in-memory rate limiters count separately in each, and SQLite allows one writer.
- **Rate limiters other than sign-in count in memory** and reset when the process restarts. Sign-in is counted in the database.
- **Shopify and WooCommerce product approval puts stock at the approver's store**, not at the connected store's configured
  `income_sources.store_id`. Invisible with one store; a product decision before there are several mapped to different channels.
- **One currency.** Amounts are Kenyan shillings in cents; there is no currency setting.
- **A reset password is shown once to the admin, not delivered.** Resetting someone's password returns a temporary password for the
  admin to pass on; nothing is sent by email or SMS.
- **No variant grouping.** A Shopify or WooCommerce variant ("Crew Tee, Blue, M") imports as its own product row; there is no shared
  parent, so "total stock across all sizes" is not a query the system can answer.
- **Backups protect the data, not the machine.** The local copies share the disk with the database; the off-site encrypted copy needs
  email and `BACKUP_PASSPHRASE` set up.
- **Part of the frontend is untyped** (`components/`, `context/`, `pages/`, `navItems.js`); add folders to the type check as they are
  touched.
