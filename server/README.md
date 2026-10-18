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
