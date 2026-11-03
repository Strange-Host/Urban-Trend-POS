import * as LocalAuthentication from "expo-local-authentication";

let busy = false;
/** The Android prompt can push the app to the background; auto-lock must ignore that. */
export const isAuthenticating = () => busy;

export async function biometricAvailable(): Promise<boolean> {
  const [hw, enrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  return hw && enrolled;
}

export async function authenticate(prompt = "Unlock Urban Trends"): Promise<boolean> {
  busy = true;
  try {
    const r = await LocalAuthentication.authenticateAsync({
      promptMessage: prompt,
      cancelLabel: "Cancel",
      disableDeviceFallback: false, // device PIN/pattern as fallback
    });
    return r.success;
  } catch {
    return false;
  } finally {
    // let the AppState 'active' event from the prompt closing pass first
    setTimeout(() => {
      busy = false;
    }, 600);
  }
}
