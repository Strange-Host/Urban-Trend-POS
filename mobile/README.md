# Urban Trends mobile (v1 skeleton)

Expo (React Native, TypeScript) Android app. This step: login, biometric unlock, home screen, running against a mock of /api/v1.

## Run
    npm install
    npx expo start        # then open in Expo Go on the phone, or: npm run android
    npm run typecheck && npm test

Mock sign-in: `owner / owner123` (everything), `manager / manager123` (catalog, stock-take review, attendance with open orders), `keeper / keeper123` (stock-take counting only).
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

## Not here yet
Per-user quiet hours (server side), OTA updates (needs the EAS project id), v2 screens. See `docs/RELEASE.md` for builds and distribution.
