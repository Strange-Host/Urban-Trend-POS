# R4: money and error hygiene

## Audit of the 25 `toFixed` / `parseFloat` calls (and the `* 100` conversions beside them)

| What it was | Count | Now |
|---|---|---|
| Decimal text from a feed or gateway turned into cents with `Math.round(parseFloat(x) * 100)` (Shopify, WooCommerce, sales sync, online orders, M-Pesa and KCB callbacks, delivery-area import, STK push amount, alert threshold) | 11, in 5 separate local `toCents` copies | `utils/money.js` `toCents` / `requireCents`, which read the digits and never multiply a float |
| Cents turned into text with `(c / 100).toFixed(2)` in messages and report lines | 9 | `money.formatMoney(cents)` |
| A percentage of an amount in float (delivery fee, VAT inside a gross figure, the discount ceiling) | 3 | `money.percentOf`, `money.inclusivePart`, and an exact basis-point comparison in `utils/discounts.js` |
| Not money, left alone on purpose | 7 | hours (`payroll`), backup size in KB, a price-change percentage shown in an alert, ratios behind the margin and attainment percentages, the parsing of rate settings before they become basis points |

Also left as they are: `parseInt(setting) * 100` for whole-shilling settings (exact integer arithmetic) and the
`toLocaleString` display helpers (display only; the plan keeps display formatting out of arithmetic, and the frontend
owns it).

## `utils/money.js`

`toCents`, `requireCents` (blank is 0, rubbish is a 422, optionally blank is refused), `formatMoney`, `percentToBp`,
`percentOf`, `inclusivePart`, `roundDiv`, `allocate` / `split` (shares that always add back to the total).

Before switching any call site over it was swept against the old formulas: every 2-decimal amount from 0.00 to
20,000.00 (2,000,001 values) parses identically; `percentOf` matches the old float result for 2,400,008 amount and rate
combinations; the VAT split matches for 800,004. So for ordinary inputs nothing changes by a cent.

## One error type

`ApiError` was already the shared type and the error handler already understands only it. The audit found no other
Error subclass in `src/` (apart from the migrator's, which runs before the app). Three plain `Error`s that a request or
webhook could reach are now `ApiError`s with the same message: two in `onlineOrders.service` (422) and one in
`liveSync.service` (409). The guard test keeps it that way.

## Differences you could notice (all only for input that used to be wrong)

1. Shopify, WooCommerce and sales-sync prices with a thousands separator (`"1,500.00"`) now read as 150000 cents. The
   old code read them as 100.
2. A price that is not a number is refused with a 422 naming the field. It used to be `NaN`, which failed a NOT NULL
   constraint with a generic conflict. A missing Shopify price is still refused.
3. An amount with three or more decimals rounds as the decimal text reads (`"1.005"` is 101 cents). The float way gave 100.

## Checks

- Backend: 92 files, 1,087 tests, all passing (R3's 1,064 plus 23).
- `tests/money.test.js` (18): parsing, float traps, round trips, `formatMoney` against the old `toFixed` for every value in
  range, percentages, split/allocate, delivery fee, the discount ceiling.
- `tests/characterization/moneyAndErrors.test.js` (5): fails on `Math.round(x * 100)`, `(c / 100).toFixed()`, a new
  `parseFloat` outside the listed rate/hours files, a new Error subclass or a hand-built status error. Mutation-checked.

## Not done

- No caller uses `split` / `allocate` yet; it is there, tested, for the first feature that needs to divide an amount.
- Not run against live data. The money paths are covered by the R0 characterization tests and the existing sync tests.
