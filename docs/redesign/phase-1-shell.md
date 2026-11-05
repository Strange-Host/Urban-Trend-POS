# Redesign Phase 1: the shell

The new rail-based shell, built behind the `ut_ui=v2` flag. With the flag off nothing changes: `Layout.jsx` is untouched
and still what everyone sees. Turn the flag on (see `phase-0-baseline.md`) to try it.

## What it is

| Part | File | Notes |
| --- | --- | --- |
| Shell | `components/v2/LayoutV2.jsx` | rail + status line + page outlet + bottom bar; loaded as its own chunk, only when the flag is on |
| Rail | `components/shell/Rail.jsx`, `RailItem.jsx` | 76px ink rail, large screens. UT mark (home), nav items, then Search, Alerts, Settings, online indicator, account menu |
| Phone bar | `components/shell/BottomBar.jsx` | four destinations and More; More holds the rest, Settings, Search, Alerts, connection state, account menu |
| Status line | `components/shell/StatusLine.jsx` | branch, connection, shift state; each part is left out quietly if its lookup fails |
| Rail rules | `components/shell/railModel.js` | which items a person gets, flat or workspace rail, which is active. Plain functions, tested per role |
| Workspace pages | `components/shell/WorkspaceTabs.jsx` | plain link strip for the pages in the current workspace (see "Pulled forward" below) |
| Navigation map | `components/navItems.js` | each page now has a `workspace`; adds `WORKSPACES`, `ROUTE_ORDER`, `FLAT_BELOW`, `homeRouteFor` |

Workspaces, as in the plan: Today (Dashboard), Sell (Terminal, Orders, Leads, Sales history, Approvals), Stock (Catalog,
Stock control, Shopify sync), Money (Finance, Reconciliation, Money at risk, Requisitions, Reports), Team (Attendance,
Payroll, Staff, Onboarding, Activity log). Settings is in the bottom stack, admin only.

Flat rail: a person with fewer than 8 destinations (cashier 7, storekeeper 2) gets one rail item per page instead of
workspaces. Admins (20) and managers (16) get the workspace rail.

`App.jsx`'s `Home()` now asks `homeRouteFor` where each role starts, so the landing page and the rail's logo cannot disagree.
Behaviour is unchanged: storekeeper to Catalog, admin and manager with `reports.view` to Dashboard, everyone else on the till.

## Where the top bar's functions went

| Was | Now |
| --- | --- |
| Notifications bell | rail bottom stack (large screens); top of the More panel (phones). Panel opens beside the rail |
| User menu (theme, lock, security, sign out, layout switch) | the same `UserMenu`, as the avatar in the rail's bottom stack; at the bottom of the More panel on phones |
| Connection status | online indicator in the rail; also in the status line |
| Branch display | status line |
| Shift | status line, read-only. The shift widget itself stays on the till, where it always was |
| Search / Ctrl+K | rail Search button, More panel, and Ctrl+K, all opening the existing palette |

## Where this departs from the plan

- **Old layout and its storage keys stay.** The plan says Phase 1 removes the three sidebar modes, group collapse, the sliding pill
  and the top bar, and cleans up their `localStorage` keys. Because the flag has to keep the old layout available until cutover,
  all of that moves to Phase 7. Removing the keys earlier would reset the sidebar for anyone who switches back.
- **`Layout.test.jsx` is not rewritten.** It still tests the live layout. The new shell has its own tests
  (`LayoutV2.test.jsx`, `railModel.test.js`), and the role-visibility rules for `filterVisible` now have their own file
  (`navItems.test.js`). The rewrite happens when the old layout goes.
- **`WorkspaceTabs` pulled forward from Phase 2.** The phase's own "done when" says every route is reachable from the rail, but a
  workspace item can only link to one page. A minimal link strip lets the other pages be reached now. Phase 2 restyles it as the
  underline tabs and moves it into `PageHeader`.
- **Status line sits above the page's own title for now.** There is no `PageHeader` until Phase 2, so the line and tab strip
  appear above each page's existing title instead of under it.
- **Flat-rail rule counts all destinations** (Settings excluded), where the old sidebar counted only grouped ones. The result is
  the same for all four roles.

## Decisions taken from the plan's proposals

The open decisions were not answered, so these follow the plan's own proposals. Each is easy to change.

1. Phones: bottom bar with four destinations and a More panel.
2. Top-bar functions: Alerts and avatar in the rail's bottom stack.
4. Reports: under Money.

Not touched yet, because they belong to later phases: the cashier Start screen as default home (3, Phase 3), the perforated
receipt edge (5), the typeface (6, a one-place token change) and the Attention queue source (7, Phase 4).

## Checked

- Frontend: 55 test files, 412 tests passing (49 original files untouched and passing); lint unchanged at 22 warnings, 0 errors.
- Rail contents, flat vs workspace, where each item goes, active state (including sub-pages and `/`), every page reachable for
  every role, status line (including failed lookups), Ctrl+K and the Search button, the phone bar and More panel.
- Mutation check: breaking the flat-rail threshold or the active-state matching makes 9 and 3 tests fail respectively.
- Main bundle 363.71 kB (112.85 kB gzip) against 360.81 kB after Phase 0; the shell itself is a separate 9.46 kB chunk.

## Not checked

The shell has not been looked at in a browser: none was available. Before rolling out to admins, walk each role through it at
1366×768, tablet and phone, in light and dark. Specifically look at:

- rail height on a short laptop screen (the plan's risk: it must fit at 768px; by arithmetic it does, and the middle list scrolls if not)
- the notification panel and account menu opening beside the rail and above the phone More panel
- dark theme contrast on the amber active item and the status line
- keyboard: Tab order through the rail, focus visible on every item, Esc closing More and the palette
- an offline sale and a printed receipt, with the shell on
