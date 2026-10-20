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
