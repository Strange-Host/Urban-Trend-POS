# Release and distribution

## One-time setup
1. `npm i -g eas-cli`, `eas login`, `eas build:configure` (creates the EAS project id).
2. Firebase: create a project, add the Android app `co.urbantrends.manager`, download `google-services.json` into the project root (git-ignored). Give the backend the FCM service account for sending.
3. Release keystore: `eas credentials` creates and stores it. Download a copy and keep it in two separate places. Losing it means no more updates on installed phones.

## Build
- Test build with push: `eas build -p android --profile development` (Expo Go cannot receive push).
- Release APK: `eas build -p android --profile production`. `autoIncrement` raises `versionCode` every build.
- Local alternative: `npx expo prebuild -p android` then `cd android && ./gradlew assembleRelease`; raise `android.versionCode` in `app.json` by hand.

## Publish
1. Upload the APK to the authenticated download route on the backend; share the link or a QR code.
2. Update `GET /api/v1/app/version`: `latestVersion` to the new `version`; raise `minimumVersion` only when old builds must stop (the app then shows the blocking update screen with `downloadUrl`).
3. Staff enable "install unknown apps" for their browser or file manager once.

## Over-the-air fixes
JavaScript-only fixes can ship with `expo-updates`. It is not installed yet because it needs the EAS project id: after `eas build:configure`, run `npx expo install expo-updates` and `eas update:configure`, then publish with `eas update`. Native changes (new permissions, new native modules) always need a new APK and a bumped `minimumVersion`.

## Before sideloading rules tighten in 2027
Register the app and developer identity with Google and re-check the rules closer to the date.

## Rollout
Owner and one manager, then 2-3 staff phones for two weeks, then everyone.
