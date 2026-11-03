import { useFocusEffect } from "@react-navigation/native";
import { allowScreenCaptureAsync, preventScreenCaptureAsync } from "expo-screen-capture";
import { useCallback } from "react";

/** Blocks screenshots and screen recording while the screen is focused (approvals, cost, payments). */
export function useSecureScreen(tag = "secure") {
  useFocusEffect(
    useCallback(() => {
      preventScreenCaptureAsync(tag).catch(() => {});
      return () => {
        allowScreenCaptureAsync(tag).catch(() => {});
      };
    }, [tag]),
  );
}
