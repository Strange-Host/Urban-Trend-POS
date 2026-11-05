# Redesign Phase 2: page header and tabs

One page header and one tab style, used by every page in the shell. With the `ut_ui` flag off the old layout looks the way it
did (see "Small differences in the old layout" for the exceptions); with it on, pages follow the redesign's pattern:
title and actions, then the status line, the workspace tabs, in-page tabs, content.

## What changed

| Part | File | Notes |
| --- | --- | --- |
| Page header | `components/shell/PageHeader.jsx` | the one header: title, description, eyebrow, meta, actions, in-page `tabs`. Replaces the 22 hand-written title rows. `DataUI` still re-exports it, so the 5 pages that already used `PageHeader` are untouched |
| Tabs | `components/shell/Tabs.jsx` | the one tab strip. Button tabs switch things on the page; link tabs go to sibling routes. Underline style with the flag on; today's pill style with it off |
| Section pages | `components/shell/PageSection.jsx`, `pageChromeContext.js` | wraps pages embedded in another page, so their header is a section header (no second title) |
| Workspace tabs | `components/shell/WorkspaceTabs.jsx` | now a thin wrapper over `Tabs` (links) |
| Filter chips | `components/TabBar.jsx` | filters only. A call without `variant="filter"` is drawn by `Tabs` |
| Shell | `components/v2/LayoutV2.jsx` | provides the chrome to page headers; draws it itself only above pages with no header |

**Who draws the status line and workspace tabs.** A page's `PageHeader` places them under its title and tells the shell it has,
so the shell stops drawing its own copy. A page with no header (the till, and the dashboard until Phase 4) still gets them
from the shell. Embedded pages never draw a second copy.

**Pages that front embedded pages.** Finance, Catalog and Payroll are a tab strip in front of full pages that each had their own
title. In the old layout nothing changes (tabs, then the page's own title). In the new one the page title is "Finance",
"Catalog" or "Payroll", the tabs name the sub-page, and the embedded page keeps only its description and actions. A
storekeeper's Catalog is just Products with no tabs, so Products keeps its own title there.

## Pages moved onto PageHeader

Requisitions, Categories, Staff logs, Cash sessions, Custody, Security, Pay terms, Payments, Employee onboarding, Pay runs, Payroll
(live summary), Leads, Staff, Expenses, Products, Approvals, Shopify sync, Sales history, Couriers, Stock control, Reports and
Settings: 22 pages. Orders, Reconciliation, End of day, Attendance and Money at risk already used it.

## Tabs

Page tabs moved onto `Tabs`: Orders (All orders, Needs decision, Integrity), Finance, Catalog, Payroll, Couriers, Reports, Settings
(still `?tab=`), and Stock control's own strip. Filters stayed filters: Approvals, Sales history channels, Orders channels, the
courier sheet.

## Enforcement

`src/pageStructure.test.js` fails if a page writes its own `<h1>`, draws its own tab strip, or uses `TabBar` for something
other than a filter. Its allow-lists name each exception and why; one test fails when an exception stops being true.

| Still allowed, with the reason | |
| --- | --- |
| Dashboard | greeting header and date-range switch, until Phase 4 turns it into Today |
| Login, Change password, lock screen | not pages inside the shell |

## Small differences in the old layout

Pages that wrote their own title row now use the shared header, so with the flag off these differ slightly from before:

- spacing under the title is the shared header's (about 24px) instead of each page's own
- the action button sits at the bottom edge of the header row instead of its vertical centre
- titles gained the display font's tight letter-spacing that Orders and Reconciliation already had
- Stock control's tab strip is a few pixels taller (tabs are sized for a 44px touch target)

Nothing moved, nothing was removed, and colours are unchanged. If any of these matter for the "flag off means nothing changed"
rollback promise, say so and the header can be made to reproduce a page's old spacing exactly.

## Left alone, on purpose

- Dashboard: Phase 4.
- Stock control's contents (Receive, Issue, Batches...): Phase 5 splits the file. Only its header and strip moved.
- The POS terminal: Phase 3.
- Login, Change password, the lock screen.

## Checked

- Frontend: 59 test files, 445 tests passing (the 49 original files untouched and passing, which is the main evidence that the
  old layout still behaves the same); lint unchanged at 22 warnings, 0 errors.
- `PageHeader`: both layouts, tabs, titleless pages, embedded pages, claiming and releasing the chrome. `Tabs`: both styles,
  forced underline, link tabs. Finance, Catalog and Payroll with their embedded pages in both layouts, including tab
  permissions. `LayoutV2`: who draws the chrome, including after a page with a header goes away.
- Mutation checks: making embedded pages keep their title, making the shell ignore a claim, putting an `<h1>` back in a page, and
  using a non-filter `TabBar` each make tests fail, naming the file.
- Total JavaScript shipped is unchanged (1,023,989 to 1,024,933 bytes). The main chunk looks 39 kB smaller only because shared code
  now builds into shared chunks.

## Not checked

Nothing was looked at in a browser. Before rollout, compare the old layout page by page against the baseline screenshots (still
to be taken from `main`), and walk the new layout at 1366×768, tablet and phone, in light and dark. Look especially at:

- the two stacked tab rows on pages that have both workspace tabs and in-page tabs (for example Sell > Orders)
- the Settings tab strip on a phone (it keeps its edge-to-edge scroll)
- pages in the new layout where the status line now sits under the title
- Stock control's header: branch picker beside the title, then the tab strip
