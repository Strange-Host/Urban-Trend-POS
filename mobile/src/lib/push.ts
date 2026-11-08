import Constants, { ExecutionEnvironment } from "expo-constants";
import { requireOptionalNativeModule } from "expo-modules-core";

// Push is FCM-direct (the backend sends through FCM), so we register the native device token.
// It needs a development/production build with google-services.json; Expo Go cannot receive it.
const inExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
// expo-notifications needs native parts that exist only in a development or release build. Where they are missing (Expo Go,
// some emulators) it is never loaded, so there is no error, just no push.
const pushUnavailable = () => inExpoGo || requireOptionalNativeModule("ExpoApplication") === null;

export async function registerForPush(): Promise<string | null> {
  if (pushUnavailable()) return null;
  try {
    const N = await import("expo-notifications");
    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
    await N.setNotificationChannelAsync("decisions", {
      name: "Needs a decision",
      importance: N.AndroidImportance.HIGH,
    });
    let { status } = await N.getPermissionsAsync();
    if (status !== "granted") status = (await N.requestPermissionsAsync()).status;
    if (status !== "granted") return null;
    const token = await N.getDevicePushTokenAsync();
    return typeof token.data === "string" ? token.data : null;
  } catch {
    return null;
  }
}

/** Calls onLink(deepLink) when a notification is tapped, including the one that cold-started the app. */
export async function listenForNotificationTaps(onLink: (deepLink: string) => void): Promise<() => void> {
  if (pushUnavailable()) return () => {};
  try {
    const N = await import("expo-notifications");
    const pick = (r: { notification: { request: { content: { data?: unknown } } } } | null) => {
      // the server puts "<entity>:<id>" under `link`
      const data = r?.notification.request.content.data as { link?: unknown; deepLink?: unknown } | undefined;
      const link = typeof data?.link === "string" ? data.link : typeof data?.deepLink === "string" ? data.deepLink : "";
      if (link) onLink(link);
    };
    pick(await N.getLastNotificationResponseAsync());
    const sub = N.addNotificationResponseReceivedListener(pick);
    return () => sub.remove();
  } catch {
    return () => {};
  }
}
