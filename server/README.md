# Urban Trends POS server v2

PostgreSQL + TypeScript, built phase by phase from the Implementation Plan v3. It runs **beside** the legacy `backend/` (SQLite) until the cutover in phase 8; nothing here touches the live system.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Runs the tests. Starts its own throwaway Postgres automatically, so no setup is needed. In CI it uses `TEST_DATABASE_URL` instead. |
| `npm run typecheck` | TypeScript check with no output. |
| `npm run migrate` | Applies pending migrations to `DATABASE_URL`. |
| `npm run integrity` | Runs the integrity check once, now, and exits non-zero if anything is wrong (`integrity:prod` on a built server). Use after a deploy or a backup restore. |
| `npm run dev` | Server with auto-reload (needs `DATABASE_URL` and a migrated database). |
| `npm run build` then `npm start` | What Railway runs: compile, migrate, then serve. |

## Migrations

SQL files in `migrations/`, named `0001_name.sql`, `0002_name.sql`, and so on.

- Numbers must be contiguous. A gap, a duplicate or a badly named file stops the run.
- **Never edit an applied migration.** Its checksum is stored; an edit stops the run. Add a new file instead.
- Each migration runs in one transaction. A failure leaves nothing half-applied.
- Safe if several instances start at once: one migrates, the others wait.

## Health

`GET /api/health` returns `{ status, database, migrations }`, or 503 if the database is unreachable. Use it as the Railway health check.

## Errors

Every error is `{ "error": { "code", "message" }, "details"? }`, the same shape as the legacy backend.

## Money core (phase 2)

Built in `src/ledger/` and `src/integrity/`, with the rules enforced **in the database** (`migrations/0002_ledger.sql`) so no code path can break them quietly:

| Rule | How it is enforced |
| --- | --- |
| 1. Every ledger entry balances to zero | A deferred constraint trigger refuses an entry whose lines do not sum to 0, has fewer than two lines, or has none. |
| 7. Money records are immutable | UPDATE, DELETE and TRUNCATE on the ledger, receipts and order references are refused. A correction is a reversing entry that exactly negates the original and carries a reason and an actor. An entry can be reversed once. |
| 10. Order references are unique, immutable, never reused | Primary key plus the immutability triggers; the generator is a keyed bijection over a database sequence, so collisions cannot happen. |

Amounts are integer cents; debits are positive, credits negative. Use `postEntry`/`postEntryTx`, `reverseEntry`, `allocateOrderRef`, `issueReceiptTx` and `withIdempotency`; never write to these tables directly.

**Order references** look like `UT-7K49M2XQ`: seven characters and a Luhn mod-32 check character, no `0 O 1 I`. Matching ignores case, spaces and the dash. Old codes (`UT000123`) are kept as permanent aliases.
**`ORDER_REF_KEY` must never change** once references exist; the app records a fingerprint and refuses to issue with a different key.

**Nightly integrity job** runs at 02:00 East Africa Time, stores each result in `integrity_runs`, and logs an error naming every violation. It also reports if a protection trigger has been disabled or removed. A database lock keeps multiple instances from running it twice.

**Not protected by the database:** a Postgres superuser or table owner can still disable triggers. That is why the nightly job checks the data and the triggers themselves.

## Orders and payments (phase 3)

Code in `src/orders/`, tables in `migrations/0003_orders_and_payments.sql`. No HTTP endpoints or screens yet: the new server has no login, products, customers or leads until later phases, so this phase is the tested core that those will call.

**Orders.** `createOrder` allocates the permanent reference, stores the lines, logs a `created` event and books what is owed (customer receivable / sales) in one transaction. A discount can never exceed its line or the sale. A phone number can have only one active order (a database index, so two people creating at once cannot both succeed). An order's reference, customer, amounts and lines never change; only its status and assignment do, along the legal paths (`awaiting_dispatch` to `dispatched` or `cancelled`; `dispatched` to `delivered` or `returning`). Every change is an append-only `order_events` row.

**Delivery attempts.** `recordDeliveryAttempt` keeps every attempt. Delivered completes the order; rescheduled needs a date and keeps it out; not claimed and refused send it back. A reason is required unless delivered.

**Payment matching** (`ingestPaybillPayment`):

| Case | Result |
| --- | --- |
| Reference found, amount equals what is owed | `applied`, receipt issued |
| Reference found, amount is less | `part_paid`, balance reduced, receipt issued |
| Reference found, amount is more | `excess`: owed part applied, the rest in suspense |
| No reference, or one that matches nothing | `suspense`: all of it waits for a person |
| Transaction code already recorded | rejected as a duplicate; returns the first result |
| Cash at the shop | `recordShopCash`: needs a reason, cannot exceed what is owed |

An order's balance is its customer-receivable balance in the ledger, and "paid" is derived from receipts, never a stored counter (Rule 2). An order can never be paid past what it owes (Rule 6): the excess goes to suspense. Money in suspense is resolved by `applySuspenseToOrder` (with `suggestMatches` to help a person choose) or `refundSuspense`.

**Money at risk** (`moneyAtRisk`): dispatched with no outcome, delivered but unpaid, unmatched payments, and returns not yet back, each with its age, amount and owner. This is the data for the manager's daily page.

**Integrity job** now also checks Rule 2 (receipts match the ledger), Rule 3 (money without an order reference, and suspense reconciling to its items) and Rule 6 (no order overpaid).

**Not in this phase:** stock deduction at dispatch (no inventory in the new server yet), courier fees and payouts (phase 4), the return inspection process, and Convert to order (it needs leads, which arrive with the data import).

## Couriers, payables and organizations (phase 4)

Code in `src/couriers/` and `src/orders/custody.ts`, tables in `migrations/0004_couriers.sql`. Like phase 3, this is the tested core with no HTTP endpoints or screens yet.

**One registry, two kinds.** `addRider` and `addOrganization` (couriers are deactivated, never deleted; a kind never changes). Riders never collect money and never log in: staff record outcomes from the rider's report (a database rule, not just code). Organizations may collect the customer's payment, have optional named agents, and can carry an overdue limit.

**Ledger entries now carry a courier.** `journal_entries.courier_id` means "what we owe this rider" and "what this organization holds" are read from the ledger itself and cannot drift from a separate counter.

**Package fee at dispatch (Rule 11).** `dispatchOrder` needs a courier and a fee entered by hand; there is no default. A zero fee needs a reason. The fee is owed from dispatch whether or not the customer claims the parcel. A database trigger refuses to mark an order dispatched without a fee line, even if the code is bypassed. A deactivated courier cannot take dispatches.

**Courier costs, kept apart from fees (Rule 12).** `recordCourierCost` then `approveCourierCost` by someone else (the database refuses self-approval). Costs and fees post to different accounts and a payout lists each as its own line, so reports can show them side by side without mixing them.

**Payouts.** `createPayout` lists what is unpaid for a courier, closes those items and posts one entry. The total is the sum of the items (never typed in), each item can be paid once, M-Pesa and bank payments need a reference, and cash comes out of the till. Zero fees owe nothing.

**Organizations that collect (Rule 5).** `recordOrgCollection` moves the money from the customer's account to the organization's: the order counts as paid but is not yet in the shop's hands. `createStatement` settles it: the organization remits cash, the fees we owe it for those parcels are netted off, and anything not covered stays owing. Expected, charged (as the organization states it, and as our own fee records show) and received are all kept, with both variances. `organizationStanding` ages what an organization holds (0-7, 8-14, 15-30, over 30 days), settling the oldest first. When the overdue part passes the organization's limit, new collect-on-delivery parcels are **paused** until it remits.

**Custody of shop cash.** Cash taken at the shop opens a custody record naming who holds it; `depositCustody` moves it to the till. Cash held for days shows as money at risk.

**Integrity job** now also checks Rule 4 (a courier's payable equals unpaid fees and approved costs), Rule 5 (an organization's receivable equals collected minus settled), Rule 11 (every dispatch has a fee line), Rule 12 (fees and costs never combined) and custody. **Money at risk** adds unpaid courier money, dispatches with no fee line, overdue organizations and cash not deposited.

**Not in this phase:** correcting a wrongly entered package fee (a fee line is immutable; there is no correction flow yet), commission and payroll (phase 5), and screens.

## Staff, commission and payroll (phase 5)

Code in `src/payroll/`, tables in `migrations/0005_payroll.sql`. Like phases 3 and 4 this is the tested core: no screens or HTTP endpoints yet, and the permission rules (`payroll.view`; approval and payment admin-only) arrive with login. Staff are identified by the same text key used elsewhere (`orders.assigned_to`, actor names) until user accounts replace it.

**The formulas are the existing system's, made exact** (whole seconds and integer arithmetic, so exactly 08:00:00 is never charged as late): a retainer for every day clocked in; a late fee for every hour or part of an hour after the start time; an absence fee for a day recorded as absent (never also late or short); a missing-hours fee for every hour or part of an hour short of the expected day; commission **per unit sold**, at a rate set by how much of the period's target was reached (under 70%, 70-80%, 80%+); bonuses added; advances and loss deductions taken off. If deductions exceed earnings the person is paid nothing and the shortfall is shown (it is not carried forward). All times are shop time (East Africa Time).

**Pay profiles and commission plans are versioned, never edited.** A change is a new row with an effective date; the profile in force on the last day of a pay period applies to the whole period, so changes should start on the first day of a period.

**Rule 8: commission only on secure money** (`commission.ts`). An order counts only when its whole total is secure and it is dispatched. Matched paybill money (including suspense a person matched) and bank receipts are secure on receipt; shop cash only once **deposited**; organization money only once the organization has **remitted** (a statement records how much of each parcel it secured, oldest first, and a parcel counts only when covered in full). An order counts in the pay period in which it became fully secure, not when it was ordered or dispatched.

**Rule 9: a locked payroll run never changes.** `generateDraft` calculates a period (regenerating replaces the draft). `approveRun` **locks** it: it recalculates and refuses if anything has changed since the draft ("stale"), so what is frozen is exactly what was reviewed and is true now; it records every order commissioned (an order can earn commission once, ever); and it stores a fingerprint of every figure. `markRunPaid` records payment. Locked runs cannot be edited or deleted in the database; two locked runs can never cover the same day; and attendance, absences and adjustments dated inside a locked period are refused. The nightly integrity check recomputes each locked run's fingerprint, so a change made around the guards is caught.

**Reports** (`reports.ts`): the salary table for any period (live, or the frozen figures once locked), one person's full breakdown, a plain-text payslip and a CSV export. Payslips and CSV come **only from a locked run**, so they can always be reproduced exactly. The CSV defuses spreadsheet formulas in staff names.

**Integrity job** now checks all twelve rules: it adds Rule 8 (commission only on secure money, and each statement's secured amounts add up to what it settled) and Rule 9 (locked runs unchanged).

**Not in this phase:** posting payroll to the ledger (salary and commission expense are not yet ledger entries), an approval workflow for advances (they are recorded directly), corrections to attendance (a clock-out is set once), and a way to top up an organization shortfall so its short parcels can start earning commission.

## POS sales, discounts and the till (phase 6)

Code in `src/pos/`, tables in `migrations/0006_pos_and_till.sql`. Like phases 3 to 5 this is the tested core: no screens or HTTP endpoints yet. Roles (`cashier`, `manager`, `admin`) are passed in by the caller and checked against the policy tables; real permission enforcement arrives with login.

**Checkout** (`checkout`) needs an open till session. It posts the payment method(s) in, any discount to its own `SALES_DISCOUNTS` account, and gross sales out, in one transaction with its audit rows. Payments must add up to the total (checked by a deferred database trigger too). A retried or queued sale is safe: the same `clientSaleId` returns the first sale. Card and mobile-money payments need their reference.

**Discount controls**, in this order: a discount can never exceed its line or the sale (a database rule as well as a service rule); any discount needs an active **reason code**; a discount above the cashier's **role limit** (default: cashier 5%, manager 20%, admin 100%, as a share of the sale) needs a **manager or admin who is not the cashier**, whose own ceiling (manager 50%, admin 100%) covers it. Limits are versioned policy rows, never edited. Percentages are compared in exact integer arithmetic, so exactly at the limit is allowed and one cent over is not. `discountsByStaff` ranks cashiers by how much, how often, how many needed approval, and why.

**The till.** One open session per cashier. Cash moves in and out only as **cash movements** (paid-out, drop, top-up), each with a reason and a **second person's approval** (the database refuses self-approval), and never more cash than the drawer should hold. **Close-out** (`closeSession`): the cashier counts cash, card and mobile money separately; any difference needs a reason; the difference is **posted to the ledger** (over and short) so the books match the count; and a total difference above KES 500 needs a manager's `signOffSession` (the cashier cannot sign off their own).

**Void and refund.** Both need a reason and a manager's approval. A **void** reverses the sale's ledger entry exactly, and is only allowed while the session is open and nothing has been refunded; after close-out the cash has been counted, so **refund** instead. A **refund** pays back by a method the customer used, from the refunder's own open drawer, never more than was sold or paid; amounts use cumulative rounding so refunding every unit in pieces returns exactly what was paid.

**Audit.** Every checkout, discount, void, refund, cash movement and session open/close writes an `audit_log` row in the same transaction as the action, with who, how much and a risk level. `riskyActions` ranks people by voids, refunds, approved discounts, paid-outs and till differences.

**Integrity job** now also checks: each sale matches its ledger entry; nothing is refunded more than was sold or paid; every closed session still reconciles and its difference was posted; a discount above a cashier's limit has a manager's approval. **Money at risk** adds out-of-balance close-outs awaiting sign-off and sessions left open.

**Not in this phase:** stock (there is no inventory in the new server, so sales, voids and refunds do not move stock), card settlement into the bank, the offline-queue client, and audit rows for earlier phases' actions. Logins and permission changes are audited when login exists.

## Login, permissions and the API (step 1 of the build-out)

Code in `src/auth/`, `src/routes/`, `src/http.ts`; tables in `migrations/0007_users_and_sessions.sql`.

**Who is calling.** `POST /api/auth/login` returns an opaque bearer token (12 hours by default, `SESSION_HOURS`). Send it as `Authorization: Bearer <token>`. Only a SHA-256 of the token is stored, so a copy of the database cannot take over a session. Passwords are scrypt-hashed (built into Node, nothing to compile). `GET /api/auth/me`, `POST /api/auth/logout` and `POST /api/auth/change-password` complete the set.

**Roles come from the session, never from the request.** `requireAuth` sets `req.user`; `requirePermission('payroll.approve')` checks the matrix in `src/auth/permissions.ts`, the one place to read or change what each role may do. The name recorded as `actor` on every action is the logged-in username. Admin-only: approving and paying payroll, paying courier payouts, managing users and discount policy. Managers can view and prepare payroll, approve till and discount actions, and see reports. The discount policy tables (`cashier`, `manager`, `admin`) still decide discount limits; they now receive the real role.

**Accounts.** Usernames are the key every earlier record already stores as text, so a username can never change and a user can never be deleted (database triggers): deactivate instead. A new or reset account gets a random one-time password, shown once, and can do nothing but change it (`PASSWORD_CHANGE_REQUIRED`). Five wrong passwords lock the account for 15 minutes; an unknown username costs the same time as a wrong password and gets the same answer. Changing a role, deactivating, resetting or changing a password ends the affected sessions at once. An admin cannot change their own role or deactivate themselves, and the last active admin can never be removed. Logins, failures, lockouts and every account change are in `audit_log`.

**First admin.** There is no default password anywhere. From a shell on the server: `npm run create-admin -- --username jon --name "Jon"` (on Railway: `npm run create-admin:prod -- ...`). It prints a one-time password once.

**Endpoints so far.** `/api/auth/*`, `/api/users` (admin), and the payroll run endpoints `GET/POST /api/payroll/runs`, `GET /api/payroll/runs/:id`, `POST .../approve`, `POST .../pay`, which prove the pattern: view is `payroll.view`, generating a draft is `payroll.manage`, approve and pay are admin only. Requests are validated with zod (a bad one is a 422 naming the fields). Every other phase 3 to 6 function still needs its endpoints; each is a few lines on this pattern and arrives with its screen.

**Not in this step:** a login screen (the old frontend talks to the old backend), IP-based rate limiting (add `trust proxy` and a limiter when the public address is settled), SMS two-factor, per-user permission overrides.

## Master data: products, stock, customers, leads (step 2 of the build-out)

Code in `src/stock/`, `src/catalog/`, `src/customers/`, `src/leads/`, routes in `src/routes/{catalog,customers,leads}.ts`, tables in `migrations/0008_master_data.sql`.

**Stock is a list of movements, never a counter.** What is on hand is the sum of a product's `stock_movements`; they can never be edited or deleted, and a database trigger refuses any change that would leave a product below zero. Types: `receipt`, `adjustment` and `write_off` (both need a reason), and the ones the system posts itself: `sale`, `void_reversal`, `refund_restock`, `dispatch`, plus `return_restock`, reserved for step 3's returned-order handling. A sale, dispatch, void or refund can move a product's stock only once (a unique index on its cause), so a retry never deducts twice.

**What moves stock, and when.** An order **reserves** stock when it is created: a tracked item needs `on hand - reserved` to cover it, or the order is refused with `INSUFFICIENT_STOCK` and the shortfall per product. **Dispatch** takes the goods out and needs them physically there. A **POS sale** takes stock out (and cannot sell what an awaiting order is holding); a retried or offline-queued sale takes it once and still replays even when stock has since run out. A **void** puts everything back. A **refund** restocks the refunded quantity by default; pass `restock: false` for damaged goods. Cancelling an awaiting order releases its reservation. Two people grabbing the last unit are serialized by a lock on the product, so exactly one succeeds.

**Which items are tracked.** An order or sale line is matched to a product by SKU (case and spacing ignored). A product with `trackStock` off, or a line with no known SKU, is simply not tracked, so free-typed items keep working. A deactivated product is always refused. **Strict mode** (`PUT /api/stock/strict`, admin) makes every line name a catalogued product: switch it on at cutover so nothing slips through untracked.

**Products** keep a permanent SKU (a database rule) and are never deleted, only deactivated. Price and cost can change (orders keep the price they sold at) and every price change is audited. Each product reports `onHand`, `reserved`, `available` and `lowStock` (at or under its reorder level).

**Customers** are created automatically, one per phone number (the last nine digits, however it was typed), by the first order or lead. `GET /api/customers/lookup?phone=` returns the record and their history (orders, delivered, returned, active, lifetime value). A manager can flag a customer **prepay-only** with a reason: **dispatch is then refused until the order is paid in full**.

**Leads and messages.** One open lead per phone number: a repeat enquiry adds its message to the existing lead (`duplicate: true`) instead of creating a second. Status runs `new, contacted, qualified`, never backwards; `lost` needs a reason and can be reopened (unless the number has since started another lead). Assigning needs a manager and an active user. The message log (inbound, outbound, notes) is never edited. **Convert to order** (`POST /api/leads/:id/convert`) creates the order and closes the lead in one transaction: if stock is short, the phone already has an active order, or anything else fails, neither happens; two people converting at once get exactly one order.

**Nightly checks** now also prove the stock: never negative; every dispatched order took exactly its tracked goods out; no stock taken for an order that was never dispatched; every sale took its goods; a voided sale returned all of them; no refund restocked more than was refunded. The new protections (products, stock movements, customers, lead messages) are on the guard list.

**Not in this step:** returned parcels going back on the shelf or being written off (step 3, with the returned-order money handling), posting stock value to the ledger (no inventory or cost-of-goods accounts yet), stock for orders pulled from Shopify/WooCommerce (Phase 7), and importing the old catalog (Phase 8). Orders and till endpoints and the screens are step 3.

## The API for phases 3 to 6, and the staff screens (step 3 of the build-out)

Routes in `src/routes/{orders,couriers,pos,payroll,reports}.ts`; screens in `public/` (served at `/app/`, no build step); migration `0009_returns_and_alerts.sql`.

**Every route is guarded.** Each names the permission it needs (`src/auth/permissions.ts`), and `tests/apiMatrix.test.ts` lists every route with the lowest role allowed: it fails if a route forgets its guard or a guard is loosened. The acting person is always the logged-in user, never a name in the request. Money leaving the business is admin only (paying couriers, approving and paying payroll, pay rates, discount limits); everything else a manager does.

**Manager approval is by password.** Voids, refunds, cash movements and discounts over a cashier's limit need a second person. Their own username and password are entered on the same device (`approval: { username, password }` in the request); the server checks them with the same lockout as logging in, requires an approver role, refuses the requester approving themselves, and audits the approval. The two-person rules already in the services (a cost's recorder cannot approve it, till sign-off by someone else) still apply.

**Returned parcels.** `POST /api/orders/:ref/returned` counts a parcel back in, line by line: goods back on the shelf add to stock, damaged goods do not, anything else is recorded as missing (needs a note, and is a risky audit entry). The order moves from `returning` to `returned`. The part of the order the customer never paid is taken off sales; money the customer did pay stays against the order and is reported as `customerCreditCents` to refund. The nightly check proves the shelf count, the record, and that a returned order is no longer owed.

**Alerts.** A failed nightly integrity check now raises an alert (one open at a time) that shows at the top of the Money at risk screen until a manager acknowledges it with a note. `GET /api/alerts`, `POST /api/alerts/:id/acknowledge`.

**Screens** (`/app/`): login and forced password change; Money at risk (alerts, items needing action, unmatched payments to match or refund, shop cash to deposit); Orders (list, search, detail with dispatch, outcome, cancel, shop cash, receiving a returned parcel); New order; Couriers (owed, payout, costs and their approval, organization collections and statements); Till (open, sell with approval, void, refund, cash movements, close, sign-off); Pay (everyone sees their own, managers see the salary table, runs, advances, absences, admins set rates); Discounts and risky actions. Everything from the server is shown as text, never as HTML, and the page is served with a strict content-security policy. `tests/ui.test.ts` loads the real screens against a real server and database and visits each one.

**Not in this step** (small gaps from the plan, still open): correcting a package fee that is already paid; writing off an organization shortfall that will never come; collecting or forgiving what a staff member owes; a pending-then-approved workflow for advances (today a manager records one directly); correcting attendance after the fact; settling card money into the bank; carrying the opening float between till sessions; screens for products, stock, customers and leads (their API exists). Also: the refund screen refunds by item and quantity but not part of a price; and there is no printing of receipts or payslips from the screen yet (payslips are available as text from the API).
