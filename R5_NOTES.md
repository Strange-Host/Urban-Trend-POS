# R5: frontend foundation (typed contracts)

The shell half of R5 (rail, `PageHeader`, `Tabs`, `WorkspaceTabs`, the `ut_ui` flag) was already built as redesign phases
1 and 2. This stage adds the other half: typed contracts on the data layer, so the page splits in R6 cannot break a call
silently.

## What it is

JSDoc types plus `checkJs`, checked by the TypeScript compiler as a dev tool. No file is converted to TypeScript, there is
no build step, and nothing runs in production.

| Piece | Role |
|---|---|
| `frontend/jsconfig.json` | `checkJs` for `src/api`, `src/hooks` (which holds the zustand stores) and `src/utils/uiVersion.js` |
| `frontend/src/types.d.ts` | Shared `Id`, `Payload`, `Params`. Never imported at runtime. |
| `frontend/scripts/typecheck.mjs` | `npm run typecheck`. Fails only on errors inside the typed folders (see below). |
| `.github/workflows/ci.yml` | Runs `npm run typecheck` after lint in the frontend job. Not in the production build. |
| `typescript` | devDependency only |

## What is typed

- `api/endpoints.js`: every one of the 296 endpoint functions has typed parameters (`Id`, `Payload`, `Params`, or a plain
  type), so a wrong argument count or type at a call site in a typed file is an error.
- `api/client.js`, `fetchAll.js`, `sessionActivity.js`: token, handlers, refresh promise, error helpers, download helper.
- Stores: `useCartStore` (`CartItem`, `CartProduct`), `useOfflineQueue` (`QueuedSale`), `useConnectionStatus`.
- Other hooks in `hooks/` and the `ut_ui` flag helper `utils/uiVersion.js`.

Payload bodies are `Record<string, any>` on purpose. The backend's zod schemas own the field shapes; they are not copied
here.

## How the scope works

`tsc` follows imports, so it also reports errors in untyped files that the typed folders import (`components/`, `context/`,
`utils/`, 73 at the moment). `typecheck.mjs` ignores those and fails only on `SCOPE`. To type another folder: fix its errors,
then add it to `SCOPE` in the script and to `include` in `jsconfig.json`.

## Checks

- `npm run typecheck`: passes.
- Mutation-checked: a string passed where a number is expected, an extra argument to an endpoint, and a wrong field type in a
  queued sale each fail it; reverted.
- Frontend 59 files, 445 tests passing; lint 22 warnings and 0 errors, as at baseline.
- The production bundle is byte-identical before and after (48 files, same hashes), so nothing a user runs changed.

## Not done

- Not typed yet: `components/`, `context/` (including `AuthContext`), `pages/`, `navItems.js`. Add them as R6 splits pages.
- Not looked at in a browser: the redesign phase 1 and 2 criteria (every route reachable from the rail for each role,
  keyboard use, dark theme) are covered by the existing tests only. Walk each role before R6.
- The open decisions in `docs/redesign/phase-0-baseline.md` are still open; phases 1 and 2 followed the plan's proposals.
