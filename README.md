# Urban Trends POS

A point-of-sale and stock system for one retail shop that also sells online. One Node.js service (an Express API on SQLite) serves a
React app; it runs on a shop PC or a small server with nothing else to install.

- **Till and sales:** cash, M-Pesa, card and split payments; offline sales that sync when the connection returns; voids and refunds a
  manager approves; thermal receipts and cash drawer through a small print bridge.
- **Stock:** a main store and outlets, receiving (with drafts and batch/expiry), transfers, counts, a ledger that must always add up,
  and a nightly integrity check.
- **Online and phone orders:** Shopify and WooCommerce, dispatch with couriers, delivery settlement, returns and disputes.
- **Money:** M-Pesa and KCB payments with reconciliation, cash held by staff, expenses and petty cash, a "money at risk" list.
- **People:** a small CRM with lead distribution, attendance, the end-of-day review and payroll.
- **Safety:** sessions with a screen lock, lockouts, alerts to the owner, encrypted secrets, verified backups.

## Get it running

You need Node.js 22 or newer.

```
cd backend  && npm install && npm run migrate && npm run seed && npm start     # the API, on http://localhost:4000
cd frontend && npm install && npm run dev                                       # the app, on http://localhost:5173
```

The first run writes `backend/.env` with its own random secrets and creates the default admin account (the password is printed once;
change it on first sign-in). Production, backups, Cloudflare and the other details are in `SETUP.md`.

## Commands

| In | Command | Does |
|---|---|---|
| repository root | `npm run build` / `npm start` | the production build (frontend, then backend install) and start: runs migrations, then the API, which serves the built app |
| `backend/` | `npm test` | the API test suite, including the rules in `ARCHITECTURE.md` |
| `backend/` | `npm run migrate` (`-- --status`) | apply pending migrations (or just list them) |
| `backend/` | `npm run integrity` | check that stock equals its ledger and that order and payment totals agree |
| `backend/` | `npm run disable-2fa`, `npm run import-delivery-areas` | admin utilities |
| `frontend/` | `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` | what CI runs |

## Layout

```
backend/    the API: routes -> controllers -> services -> SQLite (src/), tests/, scripts/
frontend/   the React app: pages, components, api/, hooks/
print-bridge/   the optional local service that prints receipts and opens the drawer
mobile/     reserved for the Android app (see docs/redesign/README.md)
docs/       what the side-rail layout is, and what is still to be checked in a browser
```

## The documentation

| Read | For |
|---|---|
| `SETUP.md` | installing, running, production, backups, restoring |
| `DOCUMENTATION.md` | what the system does and how it is built: roles, data model, API, pages, security, operation |
| `ARCHITECTURE.md` | the rules the code is held to, the tests that hold it, and how to change things safely |
| `docs/redesign/README.md` | the side-rail layout: what it is, how the cashier, manager and storekeeper screens work, and what is still to be checked in a browser |
| `CHANGES.md` | what changed, newest first |
| `backend/src/db/migrations/README.md` | how to write a migration |
| `print-bridge/README.md` | setting up receipt printing |

## Status

The side-rail layout (rail, top bar, workspace tabs, the cashier's Start screen, Today, draft receipts) is the only layout: the
`ut_ui` flag and the old sidebar were removed at cutover. Per-role browser walk-throughs, other than the Receive form, are still to
be done; the checklist is in `docs/redesign/README.md`.
