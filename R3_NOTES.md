# R3: versioned migrations

Schema changes are now numbered files that run once each. `backend/src/db/migrate.js` is still the entry point
(`npm run migrate`, `npm start`, the tests), so nothing that calls it changed.

## How it is laid out

| Piece | Role |
|---|---|
| `db/baseline.js` + `db/schema.sql` | Migration `0001`, frozen. Idempotent, so any older database (empty file up to the last pre-R3 release) is brought up to date by it once and then recorded. Header comment says do not edit. |
| `db/migrations/NNNN_what_it_does.sql` | Every change from now on. Numbering starts at `0002`, four digits, no gaps. Each file runs once, inside a transaction. See `db/migrations/README.md`. |
| `schema_migrations` table | `version`, `name`, `checksum`, `applied_at` for everything applied. |
| `db/migrator.js` | The runner (`runMigrations`, `status`). |
| `db/migrate.js` | Backup step, then the runner; `--status` lists applied and pending without changing anything. |

## What the runner refuses (startup stops, nothing is changed)

An applied file that was edited (checksum differs); an applied file that is missing from the code (the database is newer
than the application); a gap, a duplicate number, a badly named file, a `0001` file; a new file numbered below one already
applied. A migration that fails keeps nothing of itself, and the error names the backup.

## Backup

Before anything pending runs on a database that already has tables, a `VACUUM INTO` copy is written to
`<data dir>/backups/pre-migration-<time>-to-<version>.db` (owner-only, last 10 kept, so Settings lists it and it can be
restored). A brand-new empty database gets no backup.

## Tests (`tests/migrations.test.js`, 16)

- Checksum pin on `baseline.js` and `schema.sql`.
- Runner: new database, applied once, ordering, rollback of a failed file, edited file, missing file, naming and gaps,
  numbered-below-applied, Windows line endings, backup taken only when there is data, `--status`.
- Real database: a fresh install and a database from before the runner reach the same schema (compared object by object,
  data untouched), and the upgrade leaves a readable copy in `backups/`.
- Mutation-checked: removing the checksum comparison, removing the backup, and editing `schema.sql` each fail tests.

Five older tests that rebuild a legacy-shaped database now also drop `schema_migrations`, so they still exercise the
baseline on a "pre-runner" database. `stockWriters.test.js` ignores `db/baseline.js` (it is the old `migrate.js`).

## Checks

Backend: 90 files, 1,064 tests, all passing (R2's 1,048 plus 16). Frontend untouched.

## Not done

- No `0002` exists yet; the first real one will be the first schema change after this (draft receipts, approvals).
- Rollback is "restore the pre-migration copy", not per-migration down scripts. That is deliberate for SQLite.
- Not run against a copy of the live shop database. Do that before deploying: `npm run migrate -- --status` first (it
  should show `0001` pending), then `npm run migrate`, then `npm run integrity`.
