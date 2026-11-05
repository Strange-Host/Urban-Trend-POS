# Redesign Phase 0: baseline and flag

Phase 0 changes nothing a cashier, storekeeper or manager can see. It records where the frontend stands and puts the
redesign behind a flag, so Phases 1 and 2 can build the new shell without touching what people use today.

## Baseline

Taken from `main` at commit `26e148f` (tagged `baseline-pre-redesign`), with dependencies installed by `npm ci`.

| Check | Result |
| --- | --- |
| Frontend tests | 49 files, 346 tests, all passing |
| Lint (`oxlint`) | 22 warnings, 0 errors |
| Production build (`vite build`) | succeeds; main bundle `index` 359.12 kB (111.56 kB gzip) |

Not recorded here: backend tests and `npm run integrity`. Those belong to the backend safety net (R0) and were not run for this phase.

Not yet captured: the screenshot set per role (admin, manager, cashier, storekeeper) at desktop, tablet and phone sizes that the
redesign plan asks for. It needs the app running against a seeded database in a real browser, which was not available when this
was written. Take it from `main` before Phase 1 merges, since it is the before-picture for every later comparison.

After the first Phase 0 commit: 51 files, 362 tests, all passing; lint unchanged at 22 warnings, 0 errors; main bundle 360.39 kB
(111.99 kB gzip), about 1.3 kB more for the flag code and the v2 placeholder.

## The flag

The new UI is off unless someone turns it on.

| To do this | Do this |
| --- | --- |
| Turn the new UI on in this browser | open any page with `?ut_ui=v2` on the end of the address |
| Turn it off again | open any page with `?ut_ui=v1` |
| Switch from inside the app (admins only) | user menu, bottom of the sidebar: "Try new layout" / "Use current layout" |
| Check which UI you are on | v2 shows a small "UI v2 preview" marker at the bottom of the screen |

How it works:

- The choice is saved in `localStorage` under `ut_ui`. `v1` removes the key, so "off" and "never set" are the same thing.
- The address parameter is read once at start-up, saved, then removed from the address bar, so a shared link cannot switch
  someone else's browser.
- Anything other than `v1` or `v2`, or storage being blocked, falls back to today's UI.
- `<html data-ui="v1|v2">` mirrors the choice so Phase 1 onward can scope CSS to the new UI.
- A saved choice applies to the whole browser, so other tabs follow it.

Where it lives:

| File | Role |
| --- | --- |
| `src/utils/uiVersion.js` | reads, saves and announces the flag; reads the address parameter |
| `src/hooks/useUiVersion.js` | React hook over the above |
| `src/components/ShellSwitch.jsx` | picks the shell; replaces `<Layout />` in the `App.jsx` route |
| `src/components/v2/LayoutV2.jsx` | placeholder for the new shell: today's layout plus the marker |
| `src/components/UserMenu.jsx` | admin-only menu item that flips the flag |

`LayoutV2` is deliberately a wrapper around the current `Layout`. Phase 1 replaces its inside with the side rail, page
header and tabs. Phase 7 deletes the flag, `ShellSwitch`, the v1 layout and this folder together.

## The mobile-v1 branch

Checked against both plans ("check whether that branch overlaps"). Findings:

- It has no history in common with `main` (two separate root commits), so it cannot be merged or rebased onto `main` in the normal way.
- It is the older line: it has no `navItems.js` or `UserMenu.jsx`, carries an older `Layout.jsx` and `App.jsx`, and lacks the delivery
  gaps update, so merging it wholesale would undo the shell code this redesign builds on.
- Its real content is a React Native app (57 files under `mobile/`, against 2 on `main`) plus mobile backend endpoints, push
  triggers and their tests (`mobileAuth`, `mobileHome`, `mobileOpenApi`, `mobileWork`, `push`).

So the redesign does not collide with it as long as it stays unmerged: the redesign only touches `frontend/`. When the mobile app
is brought over (the restructure plan starts it after R5), port the `mobile/` folder and the backend pieces as new commits on
`main`; do not merge the branch. It also removes the stray `frontend/node_modules` file, which `main` still tracks.

## Open decisions (redesign plan section 6)

The plan says these need an answer before Phase 1. Proposals are the plan's own.

| # | Question | Proposal | Decision |
| --- | --- | --- | --- |
| 1 | Phone form of the rail (no top bar) | bottom bar with four workspaces and a More sheet; mobile mockups needed | open |
| 2 | Where notifications, user menu, theme, lock, shift widget and branch display go | Alerts and an avatar button in the rail's bottom stack | open |
| 3 | Cashier start screen as the default home | autofocus New sale; user-menu option to open on the till | open |
| 4 | Where Reports lives | under Money | open |
| 5 | Perforated receipt edge on the till ticket | keep or remove (mockup drops it) | open |
| 6 | Typeface | mockups use Schibsted Grotesk, repo uses Space Grotesk, Inter and JetBrains Mono; one-place token change in `index.css` | open |
| 7 | Attention queue source | combine existing endpoints in the client now, or add an endpoint | open |

## Role walk-through inventory

Pages each role can reach today, from `navItems.js`. `*` means access also depends on a permission set in Staff, `^` means the
HR module must be switched on. Use this as the checklist when the plan's role walk-throughs run against v2.

| Role | Lands on | Pages |
| --- | --- | --- |
| Admin | Dashboard | Terminal, Dashboard*, Reports*, Orders, Leads, Sales history, Approvals*, Catalog*, Stock control*, Shopify sync*, Money at risk*, Finance, Reconciliation*, Requisitions^, Attendance^, Payroll*^, Staff, Onboarding^, Activity log, Settings |
| Manager | Dashboard | Terminal, Dashboard*, Reports*, Orders, Leads, Sales history, Approvals*, Catalog*, Stock control*, Shopify sync*, Money at risk*, Finance, Reconciliation*, Requisitions^, Attendance^, Payroll*^ |
| Cashier | Terminal | Terminal, Orders, Leads, Sales history, Approvals*, Requisitions^, Attendance^ |
| Storekeeper | Catalog | Catalog*, Stock control* |

Pages outside the sidebar that also need a look in every role: Login, Change password, Security, End of day.

## Done when (Phase 0)

- Baseline recorded and tagged. Done, except the screenshot set (see above).
- Flag exists, defaults to off, admins can switch it from the user menu, and it is covered by tests. Done.
- mobile-v1 overlap checked. Done.
- Open decisions closed. Not done: needs answers.
- With the flag off, the app behaves exactly as before: all 346 original tests pass unchanged. Done.
- With the flag on, every page still works, because the placeholder renders the current layout. Covered by `ShellSwitch.test.jsx`.
