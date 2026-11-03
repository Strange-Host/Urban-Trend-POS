# Urban Trends mobile (v1 skeleton)

Expo (React Native, TypeScript) Android app. This step: login, biometric unlock, home screen, running against a mock of /api/v1.

## Run
    npm install
    npx expo start        # then open in Expo Go on the phone, or: npm run android
    npm run typecheck && npm test

Mock sign-in: `owner / owner123` (sees unmatched payments), `manager / manager123`.
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

## Not here yet
Per-user quiet hours (server side), OTA updates (needs the EAS project id), v1.1 and v2 screens. See `docs/RELEASE.md` for builds and distribution.
