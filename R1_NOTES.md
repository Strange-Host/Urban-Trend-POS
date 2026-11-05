# R1: stock has exactly one writer

`backend/src/services/stock.service.js` is now the only file under `src/` that inserts into or updates
`inventory` or `inventory_movements` (migrations and the first-run seed are exempt). `tests/characterization/stockWriters.test.js`
fails if any other file does, with an empty allow-list.

## What moved

| Was writing stock itself | Now |
|---|---|
| `services/sales.service.js` checkout and void | `stock.applyMovement` (reason `sale` / `void`, reference_id = sale, reference_type NULL as before) |
| `services/orders.service.js` dispatch and resellable return | `stock.applyMovement` (reference_type `order`) |
| `services/requisitions.service.js` approve | `stock.applyMovement` (reason `requisition`, reference_type NULL as before) |
| `controllers/inventory.controller.js` adjust | `stock.applyMovement` + `stock.inventoryRow`; keeps its 400 messages |
| `services/reconciliation.service.js` repair | `stock.resetCache` (the one cache-only write, no ledger row, by design) |
| `controllers/products.controller.js` new-product row | `stock.ensureRow` (zero on hand, no ledger row, no drift) |

## How the old behaviour is kept

- `applyMovement` gains an optional `shortfall({ onHand, hadRow, needed })` hook so each caller keeps its own error
  wording and status: sales and dispatch keep their 409 "Stock changed while...", adjust keeps its 400 messages.
- Ledger rows are identical to before: same reason, same reference type (NULL where it was NULL), same user.
  The `reference_type` question from R0 is deliberately left open; changing it is a visible data change.

## Two small differences (both only in cases that used to go wrong)

1. Voiding a sale or accepting a good return for a product with no inventory row now creates the row. Before, the ledger
   row was written but the cache was not updated, which showed up as drift.
2. A requisition approved with a non-whole quantity is now refused (400) instead of storing a fraction in an integer column.

## For the mobile-v1 branch

`mobile-v1` has unrelated history (no merge base with `main`). It already has its own
`services/stockAdjust.service.js` that repeats the adjust logic, and it changes `inventory.controller.js` and
`requisitions.service.js`. When it is brought over, `stockAdjust.apply()` should call `stock.applyMovement` with the same
`shortfall` hook rather than writing stock itself.

## Checks

- Backend: 88 files, 1,045 tests, all passing (two upgrade-from-old-schema tests that were skipped in R0 now run,
  because the repository history is present; they pass).
- Writer guard mutation-tested: a new direct writer in a controller fails it.
