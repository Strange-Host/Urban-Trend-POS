# Redesign Phase 6: workspace tab strips (Sell, Money, Team)

The plan's Phase 6 asked for workspace tab strips over the existing routes of Sell, Money and Team, with no page logic changes,
plus the Settings split and a review of Orders. **Nearly all of it was already in place**, so this phase is a check rather than
new code:

| Plan item | Where it was done |
| --- | --- |
| A strip of the workspace's pages over each page | the shell (Phase 1: `navItems.js` gives each page a `workspace`, `LayoutV2` draws `WorkspaceTabs`) and `PageHeader` (Phase 2: draws it under the title and the shell steps back) |
| Sell: Terminal, Orders, Leads, Sales history, Approvals | `navItems.js` |
| Money: Finance, Reconciliation, Money at risk, Requisitions, Reports (cashiers keep Requisitions) | `navItems.js`; cashiers have a flat rail that lists Requisitions |
| Team: Attendance, Payroll, Staff, Onboarding, Activity log | `navItems.js`; a manager sees the two they may open |
| Split Settings, review Orders | R6 steps (Settings, Orders and every other page over 400 lines are now split) |

## What this phase added

One test file, `components/v2/WorkspaceStrips.test.jsx` (33 tests), because the existing tests covered one page's strip but not the
promise "every page of these workspaces shows the right strip". It walks the real shell, with a bare page in the outlet:

- For **admin** (15 pages) and **manager** (12 pages): every Sell, Money and Team page shows **exactly one** strip, listing exactly
  that role's pages for the workspace, with **exactly this page** marked, and the rail marks the right workspace.
- End of day (a page beneath Attendance) keeps Attendance marked; Activity log does not light Staff although their paths start the
  same way.
- **Cashier** and **storekeeper** (flat rails) get no strip on any of their pages.

Mutation-checked: marking the first tab as always active fails 22 of them, and sloppy path matching fails the Activity log cases.

## Still not checked (needs a browser)

Nothing here was looked at on a screen. For the new layout at 1366x768, tablet and phone, light and dark:

- **Two stacked tab rows** on pages that have both the workspace strip and their own tabs (Sell > Orders: All orders, Needs decision,
  Integrity; Money > Finance; Team > Payroll). They read as separate things? Which one looks like the page's main navigation?
- Whether the strip is wide enough on a phone to scroll sideways rather than wrap (Sell has five tabs, Team five).
- The strip is the same height on a page with its own header and on one without (the till), so nothing jumps between pages.

If the stacked rows look wrong against the approved mockups, that is a visual decision, not a logic one: the strip and the page's tabs
come from `WorkspaceTabs` and `Tabs`, and `PageHeader` decides how they sit.

## What is left of the plan

- Phase 7: remove the `ut_ui` flag, the old layout and unused sidebar code; write `ARCHITECTURE.md`; update README,
  DOCUMENTATION.md and CHANGES.md; final dark theme, accessibility and print passes.
- The visual restyles that depend on the approved mockups, which are not in the repo.
- The open decisions in `docs/redesign/phase-0-baseline.md` that no phase has settled.
