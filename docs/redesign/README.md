# The new layout (side-rail redesign): status, how it works, what is left

A new frontend shell (side rail, one page header, workspace tabs) and new screens for the cashier, the manager and the storekeeper,
built behind a flag. Colours and the permission model are unchanged; the backend gained two small endpoints and one migration.
This is the one document for it: it replaces the per-phase notes, which described work as it was done.

## Status

| Phase | What | State |
|---|---|---|
| 0 | the `ut_ui` flag, baseline | done |
| 1 | the shell: side rail, top bar, bottom bar below 1024px, status line | done (the rail and top bar were reworked afterwards) |
| 2 | one `PageHeader` and one `Tabs` for every page | done |
| 3 | cashier: the Start screen and the till | done |
| 4 | manager: Today, with an Attention queue | done |
| 5 | stock: draft receipts, and the Receive form on the page | done |
| 6 | workspace tab strips for Sell, Money, Team | done (already built by phases 1 and 2; a walk-through test now proves it) |
| 7 | **cutover**: remove the flag and the old layout, final passes | **not started** |

Built and tested. The Receive form has been checked in a browser (see "Before it is rolled out"); no other screen has a recorded
browser check, and that is the main thing between this and cutover.

## The flag

The new layout is off unless someone turns it on.

| To do this | Do this |
|---|---|
| Turn it on in this browser | open any page with `?ut_ui=v2` on the end of the address |
| Turn it off again | `?ut_ui=v1` |
| Switch from inside the app (admins) | the account menu: "Try new layout" / "Use current layout" |

The choice is saved in `localStorage` under `ut_ui` (`v1` removes the key, so "off" and "never set" are the same). The address
parameter is read once, saved, then removed from the address bar, so a shared link cannot switch someone else's browser. Anything
other than `v1` or `v2`, or blocked storage, falls back to the current layout. `<html data-ui="v1|v2">` mirrors it for CSS. With the
flag off the app is as it was.

Files: `utils/uiVersion.js`, `hooks/useUiVersion.js`, `components/ShellSwitch.jsx` (picks the shell), `components/v2/LayoutV2.jsx`
(the new shell, its own chunk), `components/UserMenu.jsx` (the admin switch).

## What the new layout is

**Shell** (`components/shell/`, `components/v2/LayoutV2.jsx`). From 1024px wide (`useMediaQuery`): a 64px ink **rail** on the left
(the UT mark, then the workspaces, then the account menu) and a 64px **top bar** across the page (a greeting with the date, the
status as pills for branch, connection and shift, then Search, Alerts and Settings). Below 1024px (phones and small tablets): a
**bottom bar** (four destinations and a More panel holding the rest) and no top bar, so the status line sits under the page title.
`railModel.js` holds the rules (what each person gets, flat or workspace rail, which item is active) as plain tested functions.

**Workspaces**, from `navItems.js`: Today (Dashboard), Sell (Terminal, Orders, Leads, Sales history, Approvals), Stock (Catalog,
Stock control, Shopify sync), Money (Finance, Reconciliation, Money at risk, Requisitions, Reports), Team (Attendance, Payroll,
Staff, Onboarding, Activity log). Settings is a button in the top bar, admin only. A person with fewer than 8 destinations (cashier,
storekeeper) gets a **flat rail**, one item per page; admins and managers get the workspace rail. Existing URLs are unchanged; the
workspace's pages are a tab strip over each page.

**Where the old layout's top bar functions went:** on large screens the new top bar carries Alerts, Search and Settings and the
connection, branch and shift pills; the account menu (theme, lock, security, sign out, the flag) is at the bottom of the rail. On a
phone, the More panel holds Alerts, Search and the account menu, and the status line sits under the page title. The Search pill and
Ctrl/Cmd+K open the same "go to" palette.

**Page pattern** (`PageHeader`, `Tabs`, `PageSection`): title and actions, then the status line, the workspace tabs, the page's own
tabs, then content. Cross-page tabs are links to sibling routes; in-page tabs keep the `?tab=` pattern. Finance, Catalog and
Payroll are a tab strip in front of full pages; in the new layout the page title is the section's and the embedded page keeps only
its description and actions. A page with a `PageHeader` places the status line and workspace tabs under its title; a page without
one (the till) gets them from the shell. Embedded pages never draw a second copy.

**Landing.** `components/Home.jsx` asks `homeRouteFor` (in `navItems.js`) where each role starts, so the landing page and the rail's
logo cannot disagree: storekeeper to Catalog; admin and manager with `reports.view` to the Dashboard (Today); a cashier to the
till, or on the new layout to the Start screen.

## The cashier: Start and the till

- **Start** (`pages/Start.jsx`, `/start`): big tiles, each shown only if the person may do it: New sale (focused on arrival, so Enter
  opens the till), Online orders (with how many are waiting to dispatch), Receive stock (`stock.receive`), Count stock (`stock.count`,
  which cashiers have by default), Void or refund (`sales.void_request` or `payments.refund_request`), and End shift while a shift is
  open (it opens the till with the close-shift form showing). Under the tiles: when the shift opened (or "Not open", with a link to
  open one at the till), the total sold this shift, sales waiting to sync, and any the server refused.
- **Open on the till instead:** the account menu has "Open on the till" / "Open on the Start screen" for cashiers
  (`utils/cashierHome.js`, `ut_cashier_home`).
- **The till** (`pages/POSTerminal.jsx`, `components/till/*`): an offline strip across the top, a category column, a three-column
  product grid, and a dark ticket with lines, subtotal, discount, total, payment and Charge. At the till a cashier's rail is the
  till's own: Exit till (back to Start), Sell, Orders, Approvals; the phone bar keeps the full list. The perforated receipt edge from the
  old ticket was dropped, as decided. `PaymentPanel` has a dark look with its logic unchanged.
- **Discount:** a whole-cents, sale-wide amount, never above the subtotal, with the cashier's cap read from
  `GET /api/sales/discount-limit` (the till warns; `checkoutSale` still enforces it). **`max_discount_percent` defaults to "no limit"**
  (0), so until it is set in Settings a cashier can discount up to the whole sale; managers and admins are never held to it. Set it
  before cashiers see the new till.
- **Offline:** the category list and the discount limit are kept for a day, like the product list (React Query's cache). If the limit never loaded the
  till cannot warn and the server decides when the sale syncs; a refusal shows in the rejected list.
- `GET /api/cash-sessions/current` also returns `sales_count` and `sales_total` for the shift summary.

## The manager: Today

On the new layout the Dashboard is **Today**, with Overview (the existing KPIs, chart and stock-alert tiles, unchanged) and
**Attention**, with a count badge: one row per kind of thing waiting on a decision, worst first, each linking to where it is done.
`hooks/useAttentionQueue.js` combines six existing endpoints in the browser (a single backend endpoint could replace it without
touching the screen); each is asked for a count only, only by people the API would let see it, and not at all on the current layout.

| Row | Needs | Opens |
|---|---|---|
| Damaged returns | admin or manager | `/orders` |
| Void and refund requests | `approvals.review` | `/approvals` |
| Unmatched M-Pesa | `payments.reconcile` | `/reconciliation` |
| Counts to review (submitted counts awaiting approval, not only those with a variance) | `stock.review` and `stock.count` | `/stock?tab=counts` |
| Transfers to approve | `stock.review` and `stock.transfer` | `/stock?tab=transfers` |
| Courier balances | `couriers.pay` | `/finance?tab=couriers` |

Stock control and Finance open on `?tab=` when given; with no parameter they behave as before.

## The storekeeper: Receive

- **Draft receipts** (backend: migration `0002_draft_receipts`, `stockReceiptDrafts.service.js`, `/api/stock/receipts/drafts`). A draft
  is a saved request body in its own table, so it cannot touch stock, batches, costing or reports. Submitting runs the ordinary
  receive and deletes the draft in one transaction: if the receive is refused nothing happens and the draft stays with the error;
  a second submit finds no draft, so a draft cannot put stock in twice. Saving refuses only what makes a draft unusable (not the main
  store, an impossible or future date, a missing supplier, over 200 lines, over 256 KB); every other rule is checked at submit. A
  buying price is dropped before saving for anyone who may not set one. A new supplier or product named in a draft is created only at
  submit. All routes need `stock.receive`, and a draft you may not open is "not found".
- **The form** (new layout, main store; `ReceiveTab` owns the state and checks, `ReceiveForm`, `ReceiveLineRow`, `ReceiveActivity` and
  `ReceiveHistory` are the pieces): the form is on the page, not a sheet. Lines are table rows: Item,
  Quantity, Selling price, Buying price. The layout follows the width of the form panel, not the screen (container queries): one row
  under column headings when the panel is at least 42rem wide, the item on a row of its own above the three figures at laptop
  width (the panel is only about 520px there), and everything stacked with its own label on a phone. **Item** searches the catalog, or "Not in the catalog? Add it as a new item" turns the row
  into a name field with its own selling price. Batch, expiry, image and category sit under **More**, which opens by itself when a
  row already has something in it. An existing item's selling price is the catalog price, shown read only and not sent (the receive
  records the product's current price; changing a price stays a product edit). Buying price is a field only for someone with
  `products.manage` and `products.view_cost`; everyone else sees "Set by admin". Then Save draft and Save shipment ("Start a new
  delivery instead" while continuing a draft). Beside the form: the drafts (Continue, Delete) and the latest five shipments; the full
  history table stays below. Labels in the new form are linked to their inputs; the old sheet's are not.
- **Not renamed "Submit for approval".** Stock goes on the shelf when the shipment is saved; nothing waits for approval first. "Set
  by admin" means the existing costing step, done afterwards by a manager or admin (`/stock/receipts/awaiting-cost`).

## Decisions taken (the redesign plan's seven open questions)

| # | Question | Outcome |
|---|---|---|
| 1 | Small-screen form of the rail | below 1024px, a bottom bar: four destinations and a More panel |
| 2 | Where the old top bar's functions went | first the rail's bottom stack, then a top bar on large screens (Alerts, Search, Settings, status pills); the account menu stays at the foot of the rail |
| 3 | Cashier Start screen as the default home | yes, focused on New sale, with an account-menu option to open on the till |
| 4 | Where Reports lives | under Money |
| 5 | The perforated receipt edge | dropped |
| 6 | Typeface | Schibsted Grotesk, served from the app, one typeface everywhere |
| 7 | Attention queue source | combine the existing endpoints in the browser |

## Where it departs from the plan

- **The old layout and its saved sidebar keys stay until cutover.** The plan says Phase 1 removes them; the flag has to keep the old
  layout available, and removing the keys earlier would reset the sidebar for anyone who switches back.
- **The till changed `useCartStore` and `PaymentPanel`**, which the plan said to leave alone: the cart gained the sale-wide discount
  and the payment panel a dark look. The cart, the offline queue and the till's offline and rejected-sale paths are covered by tests.
- **Phase 6 needed no new code.** The strips come from the shell and `PageHeader`; `components/v2/WorkspaceStrips.test.jsx` walks every
  Sell, Money and Team page for admin and manager and every flat-rail page for cashier and storekeeper.
- **Pages with their own tabs show two rows** (the workspace strip, then the page's tabs, for example Sell > Orders).

## Before it is rolled out

**Checked in a browser: the Receive form.** Run in Chrome with Playwright against a seeded copy, the flag on, with a storekeeper, a
second storekeeper, a manager and a cashier, and checked against the database after each step, not only on screen:

- An existing item shows its catalog price read only and sends nothing price-related.
- Save draft stores a draft and moves no stock; reload and Continue restores the line, quantity, delivery note and price; saving again
  updates the same draft. Save shipment on the continued draft added exactly 12 units, once, wrote one receipt with the delivery note,
  deleted the draft, reset the form and listed the shipment in Recent activity and the table.
- Saving an empty form posts nothing and shows "Line 1: enter how many arrived."
- A new item as a storekeeper: created at 900.00, pending approval, 5 units on the books, no buying price field ("Set by admin"), no cost
  stored; Recent activity says a new product is waiting for approval.
- Each storekeeper sees only their own drafts; the manager sees both and gets the buying price field.
- At 390px and 1920px there is no sideways scroll and Item takes the full width. (A first version with fixed column widths left Item
  about 66px wide at 1366px; the check caught it and the layout now follows the panel's width.)

The same round found and fixed two things outside the form: the Today Overview sent full timestamps as `from` and `to`, the reports
API answers 400 to anything but `YYYY-MM-DD`, so its four KPI cards never left their loading state; and a body-wide `tabular-nums`
from the font change widened every `.` `,` `:` in running text.

**Not checked on a real phone:** the stacked rows were seen in a 390px browser window, not on a device.

**Not recorded as checked anywhere else.** For each of admin, manager, cashier and storekeeper, at 1366x768, tablet and phone, in light
and dark:

- **Everywhere:** every route reachable from the rail, and every page's strip marks the right tab; keyboard (Tab order, focus visible
  on every item, Esc closes More and the palette); the rail fits at 768px (by arithmetic it does, and the middle list scrolls if not);
  the top bar's pills, Search, Alerts and Settings at 1024px and wider, and the switch to the bottom bar below it; the notification panel
  and account menu open beside the rail and above the phone More panel; dark-theme contrast on the amber active item and the status
  pills; the two stacked tab rows read sensibly, and the strip scrolls rather than wraps on a phone.
- **Cashier:** Start loads; Enter on New sale opens the till; each tile lands where it says; End shift and the rail's Shift open the
  close form once; Exit till returns to Start; sell online and offline; print a receipt; apply a discount above and below the limit.
- **Manager:** Today loads on Overview; the Attention badge equals the sum of the rows; each row opens the right page or tab; a manager
  without a permission sees no such row.
- **With the flag off:** the old layout looks as it did. Pages that wrote their own title row now use the shared header, so spacing
  under the title, the action button's position and the title's letter-spacing differ slightly, and Stock control's tab strip is a
  few pixels taller. If any of that matters for "flag off means nothing changed", the header can reproduce a page's old spacing.
- **Baseline screenshots:** take the per-role set (desktop, tablet, phone) with the flag **off**, as the before-picture.

**Deploying it changes the database** (migration `0002`): back up the live database; on a copy run `npm run migrate -- --status`, then
`npm run migrate`, then `npm run integrity`; then roll out at a quiet time. Set `max_discount_percent` before cashiers see the till.

**Rollout order:** admins first with the flag, then managers and storekeepers, then cashiers at a quiet time of day. Rollback is
switching the flag off, until cutover removes it.

## Cutover (Phase 7), when the walk-throughs are done

1. Remove the flag: `utils/uiVersion.js`, `hooks/useUiVersion.js`, `components/ShellSwitch.jsx`, the `v2Only` marker on nav items,
   the account menu's switch and `html[data-ui]`; make `LayoutV2` the layout.
2. Delete the old layout and what only it used: `Layout.jsx` (and its test), `useSlidingPill`, the sidebar's three display modes and
   group collapse, their saved `localStorage` keys (clean them up on start), the `TabBar` page variant (keep the filter chips), and
   the old layout's own top bar (not the new `TopBar`).
3. Update `README.md`, `DOCUMENTATION.md` (sections 6 and 7) and `CHANGES.md`; delete this file or cut it to what is still true.
4. Final passes: dark theme, accessibility (focus visibility, 44px touch targets, contrast, the old Receive sheet's unlinked labels
   go with the old layout), and print output for receipts, waybills and invoices.

## The mobile app

`mobile/` on `main` is empty (only a stray `.expo/devices.json`). The `mobile-v1` branch is a separate, active line: an Expo / React
Native / TypeScript app (96 files under `mobile/`, 84 of them in `mobile/src`) with its own mobile API, push triggers and tests, last
updated on 8 November (v1.1 screens, then a "v2" of the API: telesales orders, duplicate-phone approval, leads, returns). It differs
from `main` in 134 files under `backend/src`.

It has **no history in common with `main`** (two separate root commits), so it cannot be merged or rebased in the normal way, and it
is the older line: it has no `navItems.js`, `UserMenu.jsx`, side rail, `money.js` or migration runner, so merging it wholesale would
undo the shell and the restructure. Port the `mobile/` folder and the backend pieces as new commits on `main`. Two things to do while
porting: its own `stockAdjust.service.js` repeats the adjust logic and should call `stock.applyMovement` (with the `shortfall` hook)
rather than write stock itself; and its copies of `inventory.controller.js` and `requisitions.service.js` must be redone against
the thin controllers and services. The redesign only touches `frontend/` (apart from the two small endpoints and the migration
above), so it does not collide with the branch while it stays unmerged. The restructure plan starts the app after its frontend
foundation, which is done, so it is unblocked.
