# Urban Trends POS server v2

PostgreSQL + TypeScript, built phase by phase from the Implementation Plan v3. It runs **beside** the legacy `backend/` (SQLite) until the cutover in phase 8; nothing here touches the live system.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Runs the tests. Starts its own throwaway Postgres automatically, so no setup is needed. In CI it uses `TEST_DATABASE_URL` instead. |
| `npm run typecheck` | TypeScript check with no output. |
| `npm run migrate` | Applies pending migrations to `DATABASE_URL`. |
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
