# First-time setup

This is a plain, step-by-step guide to getting Urban Trends POS running on your machine for the
first time. For what the system does and how it's built, see `README.md` and `DOCUMENTATION.md` —
this document is just "how do I turn it on."

## 1. Prerequisites

- **Node.js 22 or newer** (the `engines` field in `package.json`; CI runs on 22). Very new Node
  versions (24.19+) have crashed older `better-sqlite3` builds on database writes — this project
  pins a version that avoids it, but if you're free to choose, 22 is the safe bet. See "Common
  problems" if you hit it.
- **npm** (comes with Node).

Check what you have:
```bash
node -v
npm -v
```

## 2. Backend setup

**There is nothing to configure.** The first time the server (or `npm run migrate`) runs, it creates
`backend/.env` for you with its own unique, random secrets. You never copy or edit it to get started.

Two things worth knowing:

- **Back up `backend/.env` together with `backend/data/`.** It holds `ENCRYPTION_KEY`, which unlocks
  the SMS and payment-gateway credentials saved in the database. If it's lost, those credentials
  have to be entered again in Settings (everything else keeps working).
- Your public web address, outgoing email and other server details are set **in the app**
  (Settings → Server & public address / Email), not in this file - no editing, no restart.
  `.env.example` lists the older file-based equivalents, which still work as a fallback.

Install dependencies:
```bash
npm install
```

Create the database tables, then load starter data (a default store, an admin login, and some
sample products):
```bash
npm run migrate
npm run seed
```

**Order matters** — `migrate` creates the tables, `seed` fills them in. Running `seed` before
`migrate` will fail with `no such table`.

Seeding prints the admin login you'll use (see "First login" below — the password is random and
shown once).

Start the API:
```bash
npm run dev
```

You should see:
```
Urban Trends POS API listening on port 4000
```

Leave this running in its own terminal.

## 3. Frontend setup

In a **second terminal**:
```bash
cd frontend
npm install
npm run dev
```

This prints a local URL, normally `http://localhost:5173`. Open it in a browser.

## 4. First login

Seeding prints a one-time admin password to the terminal — scroll up and look for a boxed
block like this:

```
============================================================
Created admin user — SAVE THIS PASSWORD, it is shown once:
  Email:    admin@urbantrends.com
  Password: <a random string>
  You will be required to change it on first login.
============================================================
```

Log in with that email/password. You'll be dropped straight into a forced "set a new
password" screen before you can do anything else — that's expected, not a bug. Pick a real
password there (12+ characters for an admin); nothing else in the app is reachable until you do.

If you're running the test suite (`NODE_ENV=test`), seeding uses a fixed
`admin@urbantrends.com` / `ChangeMe123!` instead, with no forced change — every test file logs
in as this account, so a random one-time password there would break the whole suite rather
than make the test database any safer.

## 5. What "working" looks like

- As admin you land on the Dashboard. The till (Terminal, under Sell) loads with sample products you
  can add to a cart.
- Catalog shows the seeded product list.
- Settings is admin-only: the Settings button in the top bar on a large screen, or under More on a phone.

If any of that doesn't load, check both terminal windows for errors before anything else —
almost every setup problem shows up as a clear error message in one of them.

## Common problems

**`Error: Cannot find module 'bcryptjs'` (or any other module) when running `migrate`/`seed`/`dev`**
`npm install` wasn't run in that folder (or was run in the wrong one — `backend/` and `frontend/`
are separate projects, each needs its own `npm install`). Run it again from inside the folder
you're working in.

**`SqliteError: no such table: ...`**
`npm run seed` was run before `npm run migrate`. Run `npm run migrate` first.

**`Error: secretOrPrivateKey must have a value`, or login fails with a 500 error**
This shouldn't happen on a normal start (the server fills in missing secrets itself). If it does, delete the `JWT_SECRET=` line from `backend/.env` and restart, or check that the `backend/` folder is writable.

**A native crash mentioning `better-sqlite3` / `RemoveEnvironmentCleanupHook` / `Assertion failed`**
This is a real incompatibility between very new Node.js versions (24.19+) and older
`better-sqlite3` builds — not something wrong with your setup. Fix:
```bash
cd backend
npm install better-sqlite3@^13.0.0
npm approve-scripts better-sqlite3
npm rebuild better-sqlite3
```
If `npm install` also warns about a package's install script being blocked
(`npm warn allow-scripts`), that's newer npm's default security behavior — approve it the same
way (`npm approve-scripts <package>` then `npm rebuild <package>`) rather than ignoring it, since
a skipped install script for a native module usually means a broken/missing binary.

**Login says "invalid email or password" but you're sure it's right**
Make sure `npm run seed` actually completed (check its output for `Seed complete.`). If you're not
sure, it's safe to wipe and start over:
```bash
cd backend
rm -rf data
npm run migrate
npm run seed
```

**CORS / "Network Error" in the browser console**
The backend already accepts the browser from this machine and from your shop network (phones and
tablets on the same WiFi) with no setup. You only need `CORS_ORIGIN` if the frontend is hosted on a
public address: set it in `backend/.env` to that URL (comma-separate several), and only those are
allowed. The backend log prints the exact blocked address the first time one is refused.

## Optional: connecting Shopify or WooCommerce

Not required for first-time setup — the POS works fully standalone. If you want to pull in
products from Shopify or WooCommerce later: Settings → Income sources → add a connection, then use
the Shopify sync page to review and approve what comes in. See `DOCUMENTATION.md` for details.

## Updating to new code (migrations)

Schema changes are numbered files in `backend/src/db/migrations/`. After pulling new code, run
`npm run migrate` in `backend/` (`npm start` at the repository root does it for you before the
server starts). `npm run migrate -- --status` lists what has run and what is pending without
changing anything.

Before anything pending runs on a database that already holds data, a copy is written to
`data/backups/pre-migration-<time>-to-<version>.db`; if a migration fails, nothing of it is kept and
the error names that copy. To go back, restore it (Settings → Backups lists it). On a shop that is
already running, try the migration on a copy of the live database first, then run `npm run integrity`,
and update at a quiet time of day.

## Optional: running the tests

```bash
cd backend  && npm test                                  # the API suite, including the rules in ARCHITECTURE.md
cd frontend && npm run lint && npm run typecheck && npm test
```

Each backend test file runs against its own throwaway database — never `data/urban_trends.db`.
Useful after pulling new code, or before trusting a change to checkout, stock or money.

`npm run integrity` (in `backend/`) checks a real database: that on-hand stock equals the ledger for
every product and store, and that order and payment totals agree. It also runs nightly inside the
server and raises an alert if it ever fails.

## Optional: backups

The database backs itself up automatically every 6 hours once the backend is running (see
Settings → Backups to check on this, or trigger one immediately). Files land in
`backend/data/backups/` (readable only by the server's user). Every backup is checked right after it is made, and
a bad one is discarded rather than kept. The schedule is remembered in the database, so a restart or redeploy
never skips a backup: anything overdue runs shortly after the server starts.

This protects you against a corrupted database file, not against losing the whole machine (on Railway: the
volume). For real disaster recovery, set up Settings → Email (SMTP) and add recipients under Settings → Backups
to also email an **encrypted** copy off-machine every 24 hours. That needs two environment variables to be set
(on Railway: Variables):

- `BACKUP_PASSPHRASE` — 12+ characters, also kept in your password manager. Without it no copy is sent. It is
  the only key to the emailed copies, and is deliberately not stored in the database that is being backed up.
- `ENCRYPTION_KEY` — already used by the app. Keep a copy somewhere safe and separate: a restored database needs
  it to read the saved SMS and payment-gateway credentials.

Failures (a backup that did not work, an off-site copy that was not sent) show in the bell for admins as well as by
email, so they are noticed even if email is not set up. The older `SMTP_*` / `BACKUP_EMAIL_TO` variables in `.env`
still work (see `.env.example`). Outgoing SMTP is blocked on Railway's Free, Trial and Hobby plans.

## Production deployment notes

These matter once you're running this somewhere other than your own laptop.

**Run it under a process supervisor, not `node src/server.js` directly.** The backend
deliberately exits on an uncaught exception or unhandled rejection (`server.js`) rather than
trying to keep running in an unknown state — that's only a safe design if something restarts it
automatically afterward. Two ready-made options are included in `backend/`, pick one:
- `ecosystem.config.js` — `pm2 start ecosystem.config.js` (needs `npm install -g pm2` first).
- `urban-trends-pos-backend.service` — a systemd unit; copy it to `/etc/systemd/system/`, edit
  the `User=`/paths inside it to match your setup, then `systemctl enable --now
  urban-trends-pos-backend`.

Both restart the process automatically if it exits, with crash-loop protection (they stop
retrying if it keeps failing immediately rather than restarting forever).

**Most rate limiters' counters reset on every restart.** Sign-in attempts are counted in the database
(so a restart does not hand an attacker a fresh allowance), but the others — checkout, webhook
delivery, manual sync, the general API ceiling (see `backend/src/config/limits.js`) — use
`express-rate-limit`'s default in-memory store: request counts live in the process's own memory, not
the database or Redis. Those reset to zero the moment the process restarts. In practice this is a minor, acceptable gap for a single-instance deployment: it just
means a restart (deploy, crash-and-recover, manual bounce) gives whoever's mid-rate-limit a clean
slate, rather than an actual security hole. Worth knowing given the point above — an auto-
restarting supervisor makes restarts more frequent than they'd otherwise be, which makes this
reset happen more often too. If you ever run more than one instance of this backend behind a
load balancer, the in-memory store stops working correctly regardless (each instance counts
independently) — that would need a shared store (e.g. `rate-limit-redis`) at that point, not
before.

## Production: on Railway

The repository root's `npm run build` installs and builds the frontend and installs the backend;
`npm start` runs the migrations (and the seed once, if `RUN_SEED=true`), then the API, which also
serves the built app. Put the database on a persistent volume (`DATABASE_PATH`) and set these
variables:

- `ENCRYPTION_KEY` and `BACKUP_PASSPHRASE` (see "Optional: backups"; keep both somewhere safe).
- `APP_BASE_URL` and `CORS_ORIGIN`: the public address of the app (`CORS_ORIGIN` only matters if the
  frontend is served from a different address than the API).
- `TRUST_PROXY_HOPS`: how many proxies sit in front (see the Cloudflare section); leave it unset with none.

Switch on GitHub's Dependabot alerts and security updates for the repository (Settings → Code
security): free, and it is how a vulnerable dependency gets noticed.

## Optional: Cloudflare in front (recommended; needs your own domain)

1. In Cloudflare, **Add a site** (the free plan) for your domain, and change the **nameservers** at your
   registrar to the two Cloudflare gives you. Wait until Cloudflare says Active.
2. Railway → your service → **Settings → Networking → Custom Domain**: add `pos.yourdomain.com`. Railway
   shows a CNAME target; add it in Cloudflare **DNS** (`pos` → the target). Leave the cloud **grey (DNS
   only)** until Railway shows the domain verified, then switch it to **orange (Proxied)**.
3. Cloudflare → **SSL/TLS** → mode **Full (strict)**.
4. Railway variables: `TRUST_PROXY_HOPS=2`, `CORS_ORIGIN=https://pos.yourdomain.com`,
   `APP_BASE_URL=https://pos.yourdomain.com`. In the app, **Settings → Server → Public web address** is
   the same.
5. Cloudflare → **Security → WAF → Rate limiting rules**: a rule for the paths `/api/auth/login` and
   `/api/auth/pin-login`, for example 10 requests per minute per IP, then Block for 10 minutes. Turn on
   **Bot Fight Mode**.
6. Update the webhook addresses in Shopify, M-Pesa and WordPress to the new domain; keep the old Railway
   address working until everything has moved.

The exact Cloudflare and Railway screen names change; Railway's "custom domain" documentation
describes the Cloudflare steps.

## Optional: trial restore of an emailed backup

On your own computer (Node 22+), in the project's `backend` folder, after `npm ci`:

```bash
BACKUP_PASSPHRASE="your passphrase" node scripts/restore-backup.js path/to/urban_trends-....db.gz.enc
```

If you never set `BACKUP_PASSPHRASE`, the server's `ENCRYPTION_KEY` is used instead (set it the same way).
The script decrypts to a separate file, checks the database is intact, prints row counts and ends with
**TRIAL RESTORE PASSED** or **FAILED**. It never touches the live database. Do this once now and again
every few months. To actually restore, stop the app and replace the live database file with the
decrypted copy (or use Settings → Backups for a local copy).
