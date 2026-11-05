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

After Phase 0: 51 files, 362 tests, all passing; lint unchanged at 22 warnings, 0 errors; main bundle 360.39 kB
(111.99 kB gzip), about 1.3 kB more for the flag code and the v2 placeholder.

## The flag

The new UI is off unless someone turns it on.

| To do this | Do this |
| --- | --- |
| Turn the new UI on in this browser | open any page with `?ut_ui=v2` on the end of the address |
| Turn it off again | open any page with `?ut_ui=v1` |
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

`LayoutV2` is deliberately a wrapper around the current `Layout`. Phase 1 replaces its inside with the side rail, page
header and tabs. Phase 7 deletes the flag, `ShellSwitch`, the v1 layout and this folder together.

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

- Baseline recorded and tagged. Done.
- Flag exists, defaults to off, and is covered by tests. Done.
- With the flag off, the app behaves exactly as before: all 346 original tests pass unchanged. Done.
- With the flag on, every page still works, because the placeholder renders the current layout. Covered by `ShellSwitch.test.jsx`.
