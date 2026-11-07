# R6: split large pages, then restyle

R6 has two halves and they stay in this order: split each large page as a pure move, then apply the redesign phases 3 to 6.

## Step 1 done: Stock control split

`frontend/src/pages/StockControl.jsx` (1,063 lines) is now a 72-line page shell plus one file per tab in
`frontend/src/pages/stock/`:

| File | Lines | Holds |
|---|---|---|
| `ReceiveTab.jsx` | 206 | receiving a shipment (the form the redesign restyles in Phase 5) |
| `IssueTab.jsx` | 74 | issuing stock out |
| `TransfersTab.jsx` | 136 | transfers between branches, with approval |
| `CountsTab.jsx` | 187 | opening and closing counts |
| `BatchesTab.jsx`, `CostingTab.jsx`, `ReconcileTab.jsx`, `ActivityTab.jsx` | 125, 87, 107, 53 | the other four tabs |
| `shared.jsx` | | `Badge`, `ProductSearch`, `Table` |
| `helpers.js` | | class strings, `kes`, `toCents`, `when`, `ISSUE_REASONS`, `ACTIVITY_LABEL` |

Components and helpers are separate files because the project's lint rule (react/only-export-components) wants a component
file to export only components.

### How it was kept a pure move

- Done by script from the original file (code copied, not retyped); each file's imports were generated from the names it
  uses.
- Line check: every code line of the old file appears in the new files, apart from imports, `export` keywords, one
  separator comment, and a two-line re-export. `StockControl.jsx` re-exports `ReconcileTab`, so
  `StockReconcile.test.jsx` and `App.jsx` needed no change.
- No visual change and no behaviour change: the frontend suite (59 files, 445 tests) passes unchanged, lint is at 22
  warnings as before, and the build succeeds.
- `StockControl.jsx` already used `PageHeader` and underline tabs from redesign phase 2, so the page pattern is untouched.

## Step 2 done: the other oversize pages

Every page that was over 400 lines is now under it, each as a pure move (no existing test was changed; the frontend suite passes
- 73 files, 552 tests - lint stays at 22 warnings and the build succeeds). Largest page file now: POSTerminal (about 300).

| Page | Before | After | Pieces |
| --- | --- | --- | --- |
| `Settings.jsx` | 1,082 | 82 | tab shell; `settings/` holds General, Backups, Payment gateways (card, fields), Income sources (the Stores tab, with its own state), Optional modules |
| `SettingsMessaging.jsx` | 486 | 4 | now only re-exports the three sections that moved to `settings/` (Customer payment details, SMS, Web-form leads) plus their shared hook, toggle and button looks |
| `Orders.jsx` | 633 | 240 | `orders/`: order list, order detail panel, channel badge, courier picker, helpers |
| `Products.jsx` | 493 | 329 | `products/`: the product form, approve, move and stock-adjust sheets |
| `Leads.jsx` | 411 | 264 | `leads/`: new-lead sheet, lead detail sheet, constants |
| `ShopifySync.jsx` | 403 | 375 | `shopifySync/`: the bulk-action bar, helpers |

The page keeps the data and the handlers; each piece gets props and holds no data of its own, apart from Income sources,
which took its own form state with it. `Settings.jsx` still re-exports `PaymentGatewaysSection`, and `SettingsMessaging.jsx`
still exports its three sections, so the existing tests and their mocks work unchanged.

### How it was checked

A script cut each page by line ranges, built each new file's imports from the names it uses, and compared every original code
line against the new files. The only lines that differ are the intended ones: `export` added to moved declarations, the
handler names a component receives as props, and the call sites. Lint and the page's own tests were run after each page.
ShopifySync had no tests, so the bulk bar got three.

## Enforcement

`src/pageStructure.test.js` now fails when a page file is over 400 lines unless it is listed with a ceiling and a reason,
fails when a listed page grows, and insists a page that drops under the limit is removed from the list. Mutation-checked
both ways. The list is empty: no page is over the limit. (POSTerminal left it in redesign Phase 3, when the ticket moved to
`components/till/Ticket.jsx`.)

## Next in this stage

1. Restyle, in this order: redesign Phase 3 (cashier), Phase 4 (manager Today) and Phase 5 part 1 (draft receipts) are in.
   Phase 6 (workspace tab strips) turned out to be built already by Phases 1 and 2 and is now covered by a walk-through test
   (`docs/redesign/phase-6-workspaces.md`). What remains is Phase 7 (cutover) and the visual restyles that need the mockups.
2. Add the files in `pages/` subfolders and the remaining components to the type check as each is touched (73 errors are
   still outside the checked scope).

## Still open

- The seven open decisions in `docs/redesign/phase-0-baseline.md`. Phase 3 needs #3 (cashier start screen) and #5 (receipt
  edge); phase 4 needs #7 (attention queue source).
- Not looked at in a browser. Walk Stock control as storekeeper, manager and admin before merging.
