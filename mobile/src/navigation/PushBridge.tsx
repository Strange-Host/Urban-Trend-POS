import { useEffect } from "react";
import { api } from "../api";
import { useAuth } from "../auth/AuthContext";
import { listenForNotificationTaps, registerForPush } from "../lib/push";
import { navigationRef, openDeepLink } from "./linking";
import * as Device from "expo-device";
import { APP_VERSION } from "../auth/AuthContext";

/** Registers the FCM token with the backend and routes notification taps to their screen. */
export default function PushBridge() {
  const { request } = useAuth();

  useEffect(() => {
    let alive = true;
    registerForPush().then((pushToken) => {
      if (!alive || !pushToken) return;
      request((t) =>
        api.registerDevice(t, {
          name: Device.deviceName ?? Device.modelName ?? "Android device",
          appVersion: APP_VERSION,
          pushToken,
        }),
      ).catch(() => {});
    });
    return () => {
      alive = false;
    };
  }, [request]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let alive = true;
    listenForNotificationTaps((link) => {
      if (navigationRef.isReady()) openDeepLink(navigationRef, link);
    }).then((fn) => {
      if (alive) stop = fn;
      else fn();
    });
    return () => {
      alive = false;
      stop?.();
    };
  }, []);

  return null;
}
