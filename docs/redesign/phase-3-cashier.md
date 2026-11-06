# Redesign Phase 3: the cashier's Start screen and the till

Both halves are built, from the approved boards (`Start`, `TillB`). All of it sits behind the `ut_ui=v2` flag. With the flag off
nothing a cashier sees changes: `/` is the till, and the old layout neither lists nor lands on Start.

## Part 1: Start screen

| Part | File | Notes |
| --- | --- | --- |
| Start screen | `pages/Start.jsx`, route `/start` | big tiles per permission, then a shift summary line. A separate chunk, loaded only by people on the new layout |
| Landing rule | `components/Home.jsx` | cashier on v2 who has not chosen the till is sent to `/start`; everything else lands where it did |
| Preference | `utils/cashierHome.js`, `hooks/useCashierHome.js`, `components/UserMenu.jsx` | `ut_cashier_home`: `start` (default) or `till`, switched from the account menu |
| Stock control | `pages/StockControl.jsx` | opens on `?tab=` when given (`/stock?tab=counts`) |

Tiles, each shown only when this person may do that thing:

| Tile | Goes to | Shown when |
| --- | --- | --- |
| New sale (double width, amber, focused on arrival so Enter opens the till) | `/terminal` | always |
| Online orders, with how many are awaiting dispatch | `/orders` | always |
| Receive stock | `/stock?tab=receive` | `can('stock.receive')` |
| Count stock | `/stock?tab=counts` | `can('stock.count')` |
| Void or refund | `/approvals` | `can('sales.void_request')` or `can('payments.refund_request')` |
| End shift | `/terminal?shift=close` | a shift is open |

Under the tiles: when the shift opened, sales this shift, sales waiting to sync, and any the server rejected. With no shift open it
says so and links to the till, where one is opened. The shift widget no longer sits on Start (End shift now opens the till's).

## Part 2: the till

| Part | File | Notes |
| --- | --- | --- |
| Rail | `navItems.js`, `shell/railModel.js`, `v2/LayoutV2.jsx` | `Start` is a `v2Only`, `uncounted` nav item (a cashier keeps the flat rail). The cashier's rail ends with a Shift item (`CLOSE_SHIFT_TO`). At the till (`tillRail`) it becomes Exit till (to Start), Sell, Orders, Approvals. Workspace rails and the storekeeper are unchanged, and so is the phone bar. The rail's logo goes to Start, or the till if that is their chosen home |
| Shift | `components/ShiftWidget.jsx`, `pages/POSTerminal.jsx` | the till turns `?shift=close` into a `closeRequest` bump and drops it from the address. The widget takes each request once, only after the open shift is known (no shift: nothing to close, request dropped). Laid out as a narrow stack |
| Layout | `pages/POSTerminal.jsx`, `components/till/*` | offline strip across the top, then category column (190px; chips on small screens), 3-column grid, dark 400px ticket |
| Ticket | `components/till/Ticket.jsx` | lines, subtotal, discount, total, payment, Charge, printer settings, last receipt. No sale logic of its own |
| Payment | `components/PaymentPanel.jsx` | Cash / M-Pesa / Card / Split in one row, with a `dark` look. State, `buildPayments` and the split rules are unchanged |
| Discount | `hooks/useCartStore.js`, `utils/discount.js`, `components/till/DiscountRow.jsx`, `salesApi.discountLimit` | a whole-cents, sale-wide amount, never above the subtotal, cleared with the cart. Sent as `discountTotal` only when above 0. Charge is blocked above the person's limit, with the reason shown |
| Categories | `components/till/CategoryColumn.jsx` | `categoriesApi.list`, and `category_id` on the product list. The list now asks for 60 products, not 20 |
| Offline | `components/till/TillBanners.jsx` | the "offline", "waiting to send" and "server rejected" banners, same wording and actions, drawn once above the whole till so they are never inside the grid or the ticket |

Dropped from the mockup, as decided: the perforated receipt edge (and its CSS).

## Backend (already on main)

- `GET /api/sales/discount-limit` -> `{ data: { maxPercent } }`: the caller's own cap (0 = none). Settings are admin-only, so a
  cashier could not read it before. `checkoutSale` still enforces the same number; the till only warns first.
- `GET /api/cash-sessions/current` also returns `sales_count` and `sales_total` (non-voided sales in the session).

## Things to know

- **The discount limit defaults to "no limit".** `max_discount_percent = 0` means no cap for anyone, so until it is set in Settings a
  cashier can discount up to the whole sale. Set it before cashiers see the new till.
- **Offline.** The category list and the discount limit are cached for a day, like the product list. If the limit was never loaded
  (offline from the first screen) the till cannot warn, and the server decides when the sale syncs; a refusal shows in the rejected list.
- **Rail length.** The cashier's rail is Start, their seven pages and Shift (nine items); the list scrolls on a short screen.
- **Page size.** `POSTerminal.jsx` fell from 403 to about 300 lines by moving the ticket out, so it is off the `pageStructure.test.js` list.

## Tests

New or changed: cart store, offline queue, till offline and rejected-sale paths, till ticket (discount, limit, categories, shift
request, banners), Start (tiles per permission, order count, End shift, summary), till rail and the Shift item, `Home` (a cashier on
v2 is sent to `/start`), discount arithmetic. `POSTerminal.split.test.jsx` now mounts inside a router; its assertions are unchanged.

## Not done

- Phone layouts for Start and the till (web first). The till's phone cart sheet still works, restyled dark.
- **Browser walk-through.** Not done. As a cashier with the flag on: Start loads; Enter on New sale opens the till; each tile lands
  where it says; End shift and the rail's Shift open the close form once; Exit till returns to Start; sell online and offline;
  print a receipt; apply a discount above and below the limit. Repeat as manager and storekeeper to see nothing changed for them.
