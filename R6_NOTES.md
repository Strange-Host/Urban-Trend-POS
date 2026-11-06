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

## Enforcement

`src/pageStructure.test.js` now fails when a page file is over 400 lines unless it is listed with a ceiling and a reason,
fails when a listed page grows, and insists a page that drops under the limit is removed from the list. Mutation-checked
both ways. The list today: Settings (1,082), Orders (633), Products (493), SettingsMessaging (486), Leads (411),
ShopifySync (403). POSTerminal left the list in redesign Phase 3, when the ticket moved to `components/till/Ticket.jsx`.

## Next in this stage

1. Settings into tab components (Business, Payments, Messaging, Branches, Server, Stores). `SettingsMessaging.jsx` already
   exists as a separate file.
2. Orders (633 lines): review for the same split.
3. Only then restyle: redesign phases 3 (cashier), 4 (manager Today), 5 (Receive form, which needs the backend check for
   draft receipts and admin approval of buying prices), 6.

## Still open

- The seven open decisions in `docs/redesign/phase-0-baseline.md`. Phase 3 needs #3 (cashier start screen) and #5 (receipt
  edge); phase 4 needs #7 (attention queue source).
- Not looked at in a browser. Walk Stock control as storekeeper, manager and admin before merging.
