# Urban Trends mobile (v1 skeleton)

Expo (React Native, TypeScript) Android app. This step: login, biometric unlock, home screen, running against a mock of /api/v1.

## Run
    npm install
    npx expo start        # then open in Expo Go on the phone, or: npm run android
    npm run typecheck && npm test

Mock sign-in: `owner / owner123` (everything), `manager / manager123` (catalog, stock-take review, attendance with open orders), `keeper / keeper123` (stock-take counting only), `agent / agent123` and `agent2 / agent123` (telesales: own orders and leads only).
More tab -> "Mock controls": offline, expire token, revoke device, force update.

## Point at the real backend
In `app.json` set `expo.extra.apiMode` to `"http"` and add `expo.extra.apiBaseUrl`.
Contract lives in `src/api/types.ts`; the HTTP client is `src/api/http.ts`.
Reconcile `types.ts` with the real responses first (field names were taken from the spec, not the server).

## Layout
- `src/api/` types, mock (`mock/mockApi.ts`), real client (`http.ts`), switch (`index.ts`)
- `src/auth/AuthContext.tsx` session state machine: booting -> signedOut | locked | unlocked | updateRequired; refresh single-flight with rotation, revoke handling, 2-minute background auto-lock
- `src/lib/storage.ts` refresh token in Android Keystore (SecureStore); access token memory only; home cache for read-only offline
- `src/screens/` Login, Lock, Update, Home, More, placeholders for Approvals and Stock

## v1 screens in the app
Login, unlock, Home (needs attention), Approvals (list, detail, approve with biometric above the owner threshold, reject with reason, "already decided" handling), Alerts, Stock (barcode scan or search, adjust with reason; large changes become an approval), Orders (filters, pagination, courier call and WhatsApp), More (security, device, mock controls).
Approvals screens block screenshots. Lists keep a per-user read-only cache for offline; every action needs a connection.

## Push
`src/lib/push.ts` registers the native FCM token through `POST /devices` and routes taps by `data.deepLink`. It needs a development or release build with `google-services.json` (see `docs/RELEASE.md`); in Expo Go it is skipped.

## v1.1 screens (open from the menu, each hidden without its permission)
- **Catalog** (`products.manage`): search, category filter, active toggle; product create/edit with a required reason on price changes, cost only with `products.view_cost`, deactivate instead of delete; **Categories** (add, rename, up/down reorder, deactivate); **Price history** per product.
- **Bulk price** (`prices.bulk`, from Catalog): category, percent or fixed, preview of every old/new price, reason, fingerprint/face confirmation, recent changes with Revert. A stale preview is refused and re-run.
- **Stock-take** (`stock.count`; approve/reject needs `stock.review`): start for the shop or a category, count by scan or name search, autosave to the server with a copy kept on the phone, submit. Small differences update stock; large ones wait for someone else to approve.
- **Reconciliation** (`payments.reconcile`): unmatched payments, ranked order suggestions with search, match, or ignore with a reason.
- **Courier remittance** (`couriers.settle`): tick parcels, expected = collected minus fees owed, amount received, reference, variance shown; history. No receipt photo (the server has no upload yet).
- **Attendance**: clock in, clock out with the confirmations and handover note the shop's rules require.

Price master: the POS owns shop prices (`price_master = pos`); approving an online listing does not overwrite them, and nothing is pushed online yet.

All writes need a connection. Nothing in this folder has been run on a device or emulator: it is typechecked and the logic and mock are unit-tested (`npm test`).

## v2 screens (telesales and returns)
- **My orders** (`telesales.work`): the online COD orders assigned to you that still need a confirmation call, oldest first, each with a countdown to the end of its confirmation window (it uses the server's clock, red under 30 minutes) and a warning when the phone number has another active order.
- **Confirm order**: customer, items and totals, Call and WhatsApp buttons, then **Confirm** (the website's COD gate), **Customer wants a later call** (pick a call-back time up to 7 days ahead; the auto-cancel window moves past it) or **Customer does not want it** (reason required). An order with a duplicate phone number cannot be confirmed until a manager approves; **Ask a manager to approve** sends the request, which appears for managers in Approvals as "Duplicate order". Someone else's order is not reachable.
- **My leads / Lead detail** (`leads.work`): agents see only their own leads. Filter by status, search, leads due for a call-back today first. Record the call outcome, add notes, move the lead along the website's status rules (call-back needs a date), and **Convert to order**; if the number already has an active order the app offers to add to it instead.
- **Returns** (`returns.receive`): find the dispatched order that came back, record the reason and the condition, and it waits for a decision. A manager (`orders.inspect`) can put good units back on sale; only the owner can write off or dispose, as on the website. Stock does not move until that decision.

In the mock, a manager answers a duplicate-phone request about eight seconds after you ask. Call-back times are picked from quick choices rather than a calendar.

## Not here yet
Per-user quiet hours (server side), OTA updates (needs the EAS project id). See `docs/RELEASE.md` for builds and distribution.
