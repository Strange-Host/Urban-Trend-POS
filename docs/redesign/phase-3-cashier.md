# Redesign Phase 3: cashier (part 1 of 2: the Start screen)

Phase 3 has two halves: the cashier's Start screen, and the restyle of the till. This note covers the first half, which is done.
The till restyle is not started; it needs the approved cashier and till mockups (see "Not done").

All of it sits behind the `ut_ui=v2` flag. With the flag off, nothing a cashier sees changes: `/` is the till, as before.

## What changed

| Part | File | Notes |
| --- | --- | --- |
| Start screen | `pages/Start.jsx` | tiles per permission, the shift panel. A separate chunk, loaded only by people on the new layout |
| Landing rule | `components/Home.jsx` | moved out of `App.jsx` so it can be tested. Cashier on v2 gets Start; everything else lands where it did |
| Preference | `utils/cashierHome.js`, `hooks/useCashierHome.js` | `ut_cashier_home` in localStorage: `start` (default) or `till` |
| Account menu | `components/UserMenu.jsx` | cashiers on v2 see "Open on the till" / "Open on the Start screen" |
| Shift widget | `components/ShiftWidget.jsx` | optional `closeRequest` prop opens its close-shift form; the Start screen's "End shift" tile uses it |
| Stock control | `pages/StockControl.jsx` | opens on `?tab=` when given (`/stock?tab=counts`); no parameter behaves as before |

## The tiles

Each one appears only when this person may do that thing, so the screen never offers a dead end.

| Tile | Goes to | Shown when |
| --- | --- | --- |
| New sale (focused on arrival, so Enter opens the till) | `/terminal` | always |
| Online orders | `/orders` | always |
| Receive stock | `/stock?tab=receive` | `can('stock.receive')` |
| Count stock | `/stock?tab=counts` | `can('stock.count')` |
| Void or refund | `/approvals` | `can('sales.void_request')` or `can('payments.refund_request')` |
| End shift | opens the close-shift form below | a shift is open |

A default cashier therefore sees New sale, Online orders and Void or refund; the stock tiles appear when an admin grants those
permissions. Below the tiles, the existing shift widget shows whether a shift is open (float, time) and opens or closes it.

## Decisions taken (from the plan's proposals)

- **#3 Start screen as default.** The plan's proposal: it adds one tap for a cashier who only sells, so New sale takes focus
  (Enter goes straight to the till) and the account menu lets a cashier open on the till instead. Both are in.
- **#5 Receipt edge.** Kept: the till still has it, since nothing has been restyled. Revisit with the till restyle.

## Tests

`Start.test.jsx` (tiles per permission, links, focus, End shift), `Home.test.jsx` (cashier on v1 and v2, the till choice, other
roles unchanged on both), `cashierHome.test.js`, `UserMenu.test.jsx` (the switch and who sees it),
`StockControl.tab.test.jsx` (`?tab=`). `StockReconcile.test.jsx` now renders Stock control inside a router, because the page
reads the URL. Frontend: 63 files, 470 tests passing.

## Not done

- **The till restyle** (rail, category column, product grid, dark ticket). The mockups are not in the repo or the plan documents,
  and the plan describes them only in a line. Not started, to avoid guessing a design that is then redone. No backend work is
  needed for the category column: `GET /api/products` already takes `category_id` and `categoriesApi` exists. Leave
  `useCartStore`, the offline queue and `PaymentPanel` logic untouched, as the plan says.
- **The rail.** On Start the cashier's rail highlights Terminal (Start is "/", which counts as wherever the home route
  points). The cashier mockup has Start, Sell, Orders, Approvals and Shift as separate items; the rail still shows today's
  pages. Changing that touches `navItems.js` and the rail tests, so it is left for the till restyle.
- **Browser walk-through.** Not done. As a cashier with the flag on, check: Start loads, Enter on the focused New sale goes to
  the till, each tile lands where it says, End shift opens the close form, the account-menu switch sticks across a reload, and
  with the flag off `/` is the till.
