# R0 baseline and safety net

Recorded 5 November 2026 on `main` (commit 26e148f), Node 22, fresh `npm ci`.

## Baseline numbers (before any restructure change)

| Check | Result |
|---|---|
| Backend tests | 84 files passed, 1 skipped; 1,012 tests passed, 2 skipped |
| Frontend tests | 49 files, 346 tests, all passing |
| Frontend lint (`oxlint`) | 22 warnings, 0 errors |
| Frontend build (`vite build`) | succeeds |
| `npm run integrity` on a fresh seeded database | passes |

After adding the R0 suite: backend 87 files passed, 1 skipped; 1,039 tests passed, 2 skipped (27 new).

## What R0 adds (`backend/tests/characterization/`)

- `stockPaths.test.js` (13 tests): till sale (cash, split, offline retry, refused for stock), void, manual adjust,
  receipt, issue, transfer (approve and reject), count (with and without adjustments), requisition.
- `orderPaths.test.js` (11 tests): order create, dispatch, cancel, refused dispatch, returns inspected good and damaged;
  order payments and refunds; courier delivery settlement (delivered, returned, frozen after close).
- `stockWriters.test.js` (3 tests): pins the list of files allowed to write stock directly.

Each money test asserts concrete numbers: totals, payment rows, the exact ledger rows written (store, quantity,
reason, reference type), the cached quantity, and that cache equals the sum of the ledger.

## Regression check on the suite itself

Three deliberate breakages were applied and reverted: void not restoring the cached quantity (1 test failed);
`applyMovement` skipping its ledger row (4 failed); a new file writing stock directly (writer guard failed).

## Findings that change the restructure plan

1. **Direct stock writers: 5 files, not about 10.** Transfers, counts, receiving, batches and products already use
   `stock.service.applyMovement`. Still writing directly: `controllers/inventory.controller.js` (adjust),
   `services/orders.service.js`, `services/sales.service.js`, `services/requisitions.service.js`,
   `services/reconciliation.service.js` (repair job). R1 is smaller than planned.
2. **Inconsistent `reference_type`.** Ledger rows from sale, void, requisition and manual adjust have
   `reference_type = NULL`; rows from receipts, issues, transfers, counts and orders set it. The tests pin today's values.
   When R1 moves those writers onto `applyMovement`, decide whether new rows get a reference type (a visible change
   to the movements list) or keep NULL.
3. **`frontend/node_modules` is a tracked 50-byte file.** `npm ci` deletes it, so git then shows it as deleted.
   Remove it from the index in R7 cleanup (or sooner).
4. **`mobile-v1` is a real branch**, not an empty one: an Expo / React Native / TypeScript app (46 files under
   `mobile/src`) that also differs from `main` in `backend/src` and `frontend/src`. It touches
   `inventory.controller.js` and `requisitions.service.js`, which R1 rewrites. A shallow fetch cannot show which side
   those differences come from. Run `git merge-base main mobile-v1` and diff from there before R1 starts.

## Not done in R0

- Per-role screenshot set (desktop, tablet, phone): needs the app running in a browser with seeded role accounts.
  It belongs with redesign Phase 0.
- Database backup of the live shop: take it before running R1 or R3 there.

## How the later stages use this

- R1: after each writer moves, run `npx vitest run tests/characterization`, then remove that file from
  `ALLOWED_DIRECT_WRITERS` in `stockWriters.test.js`. The last R1 commit leaves the list empty.
- R2 and R4: the same suite must stay green; any intended behaviour change shows up as a diff in these tests.
