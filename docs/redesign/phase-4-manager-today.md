# Redesign Phase 4: manager Today

The Dashboard becomes **Today** with two tabs, Overview and Attention. Behind the `ut_ui=v2` flag: with it off, the Dashboard is
exactly as before and makes no extra requests.

## What changed

| Part | File | Notes |
| --- | --- | --- |
| Tabs | `pages/Dashboard.jsx` | new layout only: `PageHeader` titled Today, tabs Overview and Attention (with a count badge), the range toggle on Overview |
| Queue | `hooks/useAttentionQueue.js` | combines six existing sources client-side (decision #7: "combine existing endpoints now"). Type-checked |
| Screen | `pages/today/AttentionQueue.jsx` | one row per kind of thing waiting, worst first, each a link; clear checks fold into one "All clear" line |
| Tab badge | `components/shell/Tabs.jsx` | optional `badge` on a tab item; nothing shows for 0 or when absent |
| Deep link | `pages/Finance.jsx` | opens on `?tab=` when given (`/finance?tab=couriers`); no parameter behaves as before |

Overview is the existing page unchanged: the stock-alert tiles ("Needs attention"), the KPIs, the revenue chart and the panels.

## The sources

Each is asked for a count only (limit 1), only by people the API would let see it, and re-asked every minute. A source this
person may not see is never requested, so there is no 403 noise, and it is left out of the "All clear" line too.

| Row | Asks | Needs | Links to |
| --- | --- | --- | --- |
| Damaged returns | `ordersApi.pendingOwnerDecision` (the existing `usePendingDecisionCount`) | admin or manager | `/orders` |
| Void and refund requests | `approvalsApi.list({ status: 'pending' })`, its `pending` count | `approvals.review` | `/approvals` |
| Unmatched M-Pesa | `paymentReconciliationApi.unmatched` | `payments.reconcile` | `/reconciliation` |
| Counts to review | `stockApi.counts({ status: 'submitted' })` | `stock.review` and `stock.count` | `/stock?tab=counts` |
| Transfers to approve | `stockApi.transfers({ status: 'pending' })` | `stock.review` and `stock.transfer` | `/stock?tab=transfers` |
| Courier balances | `couriersApi.payables` (riders owed money or with costs waiting) | `couriers.pay` | `/finance?tab=couriers` |

Order on screen: red (damaged returns), then orange (unmatched M-Pesa, courier balances), then amber (the rest). The tab badge is
the total number of things waiting.

A single backend endpoint can replace `useAttentionQueue` later without touching the screen.

## Tests

`useAttentionQueue.test.jsx` (order, links, counts, quiet list, permission gating, cashier asks nothing, disabled asks
nothing), `AttentionQueue.test.jsx`, `Dashboard.today.test.jsx` (current layout unchanged and silent; Today tabs, badge, switching),
`Tabs.test.jsx` (badge), `Finance.tab.test.jsx`. `Composites.test.jsx` and `Custody.test.jsx` now render Finance inside a router,
because the page reads the URL. Frontend: 67 files, 490 tests passing.

## Things to know

- **"Counts to review" is submitted counts awaiting approval, not only those with a variance.** The list endpoint has no
  variance filter. A count with no variance still needs approving, so it is a fair row, but the label is not "variances".
- **Two kinds of attention.** Overview still has the stock-alert tiles (low stock, expiring, expired, recalled, damaged); the
  Attention tab is about decisions waiting on someone. Folding the stock alerts into the queue is a later choice.
- **Not looked at in a browser.** As a manager with the flag on: Today loads on Overview, the Attention badge matches the sum of
  the rows, each row opens the right page or tab, and a manager without courier or reconcile permission sees no such row. With the
  flag off, the Dashboard looks as it did.

## Still open

Decision #7 is taken for now (client-side). The rest of `docs/redesign/phase-0-baseline.md` is unchanged. Phase 3's till restyle
still waits on the mockups.
