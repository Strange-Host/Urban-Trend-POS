# R2: thin controllers

No file under `backend/src/controllers/` touches the database any more. A controller parses input, calls a service and
formats the response. `tests/characterization/thinControllers.test.js` fails if a controller uses `db.prepare`,
`db.exec`, `db.transaction` or `db.pragma`, or imports the db handle.

## What moved

All 20 controllers that ran SQL now call a service. Handler names, routes and response bodies are unchanged; the
controller keeps the same exports, so `routes/` was not touched.

| Controller | Service |
|---|---|
| stockReceiving, stockTransfers, stockCounts, stockBatches, inventory | `stockReceiving`, `stockTransfers`, `stockCounts`, `stockBatches`, `inventory` (new) |
| reports, products, categories, expenses, payments, staffLogs, security, stores, suppliers | same-named `*.service.js` (new) |
| users | `staffAdmin.service.js` (new; sits on top of `users.service.js`) |
| sales, requisitions, pettyCash | added to the existing `sales`, `requisitions`, `pettyCash` services |
| auth | `authAccounts.service.js` (new): the user lookups and the password write. Cookies stay in the controller. |
| leadIntake | `intakeStoreId()` added to `leadIntake.service.js` |

`scopeStore` (which branch's records a caller may look at) now lives in `stockReceiving.service.js` and is taken as
`scopeStore(user, query)`. Helpers that used to take `req` now take `{ user, params }`.

## How it was kept a pure move

- The moves were done by script (code copied, not retyped): `req.user/query/params/body` became explicit parameters,
  `res.json(x)` became `return x`, and the status code stayed in the controller.
- Where a local variable already had the parameter's name, the parameter is aliased (`reqUser`, `reqBody`).
- `204` handlers still send an empty body from the controller.

## One thing that bit

`sales.service` now holds the checkout/void flow that used to be in the controller, which needs `approvals.service`, and
`approvals.service` already requires `sales.service`. A top-level require made that circular (approving a void failed with
`voidSaleWithAlert is not a function`). The approvals require is now inside `voidSaleAndResolve`, with a comment. The
approvals tests caught it.

## Checks

- Backend: 89 files, 1,048 tests, all passing (R1's 1,045 plus 3 new guard tests).
- The guard test fails against the pre-R2 controllers.
- Frontend untouched.

## Not done / for later

- The generated services keep the original comments and some verbose `reqUser` aliasing; a tidy-up pass is optional.
- API responses were compared through the existing suite and the R0 characterization tests, not against a copy of
  production data. Do that before rolling out on the live shop.
- `mobile-v1` still has its own copies of `inventory.controller.js` and `requisitions.service.js`; bring them over
  against the new services.
