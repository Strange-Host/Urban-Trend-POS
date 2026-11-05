# Database migrations

`0001` is the frozen baseline (`../baseline.js` + `../schema.sql`). It brings any older database up to date and is never
edited. Every schema change from now on is a numbered file here.

## Adding one

1. Name it `NNNN_what_it_does.sql`, the next number, four digits, lowercase words (`0002_draft_receipts.sql`).
2. Write plain SQL. The whole file runs in one transaction; if any statement fails nothing is kept and startup stops.
3. Never edit a file once it has been applied anywhere (a checksum is stored; an edited file stops the server).
   Fix forward with a new file.
4. A migration that rebuilds a table should start with `PRAGMA defer_foreign_keys = ON;` (foreign keys cannot be switched
   off inside a transaction).
5. Update the fresh-install expectations only through migrations, never by editing `schema.sql`.

## What happens at startup

`node src/db/migrate.js` (run by `npm start` before the server) creates `schema_migrations` if needed, refuses to go on
if an applied file was changed or is missing, takes a copy of the database to `backups/pre-migration-*.db` when anything
is pending on a database that already has data, then applies what is pending, once each. `--status` lists applied and
pending migrations without changing anything.
