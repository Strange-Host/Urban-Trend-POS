import Constants from "expo-constants";
import * as Device from "expo-device";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { api } from "../api";
import { ApiError, isApiError } from "../api/errors";
import { isOtpChallenge, type AppVersionInfo, type DeviceInfo, type MobileLoginResponse, type OtpChallenge, type SessionUser } from "../api/types";
import { authenticate, isAuthenticating } from "../lib/biometric";
import { compareVersions } from "../lib/format";
import { shouldLock } from "../lib/lock";
import { clearAllCaches, secure } from "../lib/storage";

export type AuthStatus = "booting" | "signedOut" | "locked" | "unlocked" | "updateRequired";

export const APP_VERSION = Constants.expoConfig?.version ?? "0.0.0";
const DEFAULT_AUTO_LOCK_SECONDS = 120;

interface AuthCtx {
  status: AuthStatus;
  user: SessionUser | null;
  offline: boolean;
  notice: string | null;
  update: AppVersionInfo | null;
  autoLockSeconds: number;
  /** Approvals of at least this amount need fingerprint or face; null = the owner never asks. */
  approvalBiometricAboveCents: number | null;
  /** Signs in. When the account uses sign-in codes the answer is the challenge to complete with verifyOtp. */
  signIn(email: string, password: string): Promise<OtpChallenge | null>;
  verifyOtp(challenge: OtpChallenge, code: string): Promise<void>;
  unlock(): Promise<boolean>;
  lockNow(): void;
  signOut(): Promise<void>;
  /** Run an authenticated call: refreshes once on expiry, handles revoke and offline. */
  request<T>(fn: (accessToken: string) => Promise<T>): Promise<T>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}

// PASSWORD_CHANGE_REQUIRED: a temporary password can sign in but cannot do anything until it is changed on the website.
const FATAL = new Set(["DEVICE_REVOKED", "REFRESH_INVALID", "PASSWORD_CHANGE_REQUIRED"]);

const FATAL_MESSAGE: Record<string, string> = {
  DEVICE_REVOKED: "This device was signed out. Sign in again.",
  REFRESH_INVALID: "Your session ended. Sign in again.",
  PASSWORD_CHANGE_REQUIRED: "Change your temporary password on the website first, then sign in again.",
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatusState] = useState<AuthStatus>("booting");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [update, setUpdate] = useState<AppVersionInfo | null>(null);
  const [autoLockSeconds, setAutoLockSeconds] = useState(DEFAULT_AUTO_LOCK_SECONDS);
  const [approvalBiometricAboveCents, setApprovalThreshold] = useState<number | null>(null);

  const statusRef = useRef<AuthStatus>("booting");
  const setStatus = useCallback((s: AuthStatus) => {
    statusRef.current = s;
    setStatusState(s);
  }, []);

  // Access token is memory-only. Refresh token is mirrored in the Keystore.
  const tokens = useRef<{ access?: string; refresh?: string }>({});
  const refreshing = useRef<Promise<string> | null>(null);
  const lockLimit = useRef(DEFAULT_AUTO_LOCK_SECONDS);
  const backgroundedAt = useRef<number | null>(null);

  const endSession = useCallback(
    async (message: string | null) => {
      tokens.current = {};
      refreshing.current = null;
      await secure.clear().catch(() => {});
      await clearAllCaches().catch(() => {});
      setUser(null);
      setOffline(false);
      setNotice(message);
      setStatus("signedOut");
    },
    [setStatus],
  );

  const applySession = useCallback((res: MobileLoginResponse) => {
    const threshold = res.settings.biometricApprovalAboveCents;
    secure
      .saveProfile({ user: res.user, autoLockSeconds: res.settings.autoLockSeconds, biometricApprovalAboveCents: threshold })
      .catch(() => {});
    setApprovalThreshold(threshold);
    lockLimit.current = res.settings.autoLockSeconds;
    setAutoLockSeconds(res.settings.autoLockSeconds);
    setUser(res.user);
  }, []);

  const refreshTokens = useCallback((): Promise<string> => {
    if (refreshing.current) return refreshing.current;
    const rt = tokens.current.refresh;
    if (!rt) return Promise.reject(new ApiError("REFRESH_INVALID", "No session", 401));
    const p = api
      .refresh(rt)
      .then(async (res) => {
        tokens.current = { access: res.accessToken, refresh: res.refreshToken };
        // rotation: the old refresh token is dead, persist the new one immediately
        await secure.saveRefresh(res.refreshToken);
        // the refresh carries the person's current permissions and the owner's app settings, so a change reaches the phone
        // within minutes instead of at the next sign-in
        applySession(res);
        return res.accessToken;
      })
      .finally(() => {
        refreshing.current = null;
      });
    refreshing.current = p;
    return p;
  }, [applySession]);

  const request = useCallback(
    async <T,>(fn: (accessToken: string) => Promise<T>): Promise<T> => {
      let lastUsed: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const token = tokens.current.access ?? (await refreshTokens());
          lastUsed = token;
          const result = await fn(token);
          setOffline(false);
          return result;
        } catch (e) {
          if (!isApiError(e)) throw e;
          if (e.code === "NETWORK") {
            setOffline(true);
            throw e;
          }
          if (FATAL.has(e.code)) {
            await endSession(FATAL_MESSAGE[e.code] ?? "Your session ended. Sign in again.");
            throw e;
          }
          if (e.code === "TOKEN_EXPIRED" && attempt === 0) {
            // only drop the token we actually used, a parallel call may already have refreshed
            if (tokens.current.access === lastUsed) tokens.current.access = undefined;
            continue;
          }
          throw e;
        }
      }
      throw new ApiError("UNKNOWN", "Request failed");
    },
    [refreshTokens, endSession],
  );

  const deviceInfo = useCallback(async (): Promise<DeviceInfo> => ({
    name: Device.deviceName ?? Device.modelName ?? "Android device",
    appVersion: APP_VERSION,
    platform: `${Device.osName ?? "android"} ${Device.osVersion ?? ""}`.trim(),
    deviceId: await secure.installId(),
  }), []);

  const startSession = useCallback(
    async (res: MobileLoginResponse, device: DeviceInfo) => {
      tokens.current = { access: res.accessToken, refresh: res.refreshToken };
      await secure.saveRefresh(res.refreshToken);
      applySession(res);
      setNotice(null);
      setOffline(false);
      setStatus("unlocked");
      // best effort; the push token is added when FCM is wired in
      api.registerDevice(res.accessToken, device).catch(() => {});
    },
    [applySession, setStatus],
  );

  const signIn = useCallback(
    async (email: string, password: string): Promise<OtpChallenge | null> => {
      const device = await deviceInfo();
      const res = await api.login({ email, password, device });
      if (isOtpChallenge(res)) return res;
      await startSession(res, device);
      return null;
    },
    [deviceInfo, startSession],
  );

  const verifyOtp = useCallback(
    async (challenge: OtpChallenge, code: string) => {
      const device = await deviceInfo();
      const res = await api.verifyOtp({ challengeToken: challenge.challengeToken, code, device });
      await startSession(res, device);
    },
    [deviceInfo, startSession],
  );

  const unlock = useCallback(async () => {
    const ok = await authenticate();
    if (ok) setStatus("unlocked"); // tokens refresh lazily on the first request, so offline unlock works
    return ok;
  }, [setStatus]);

  const lockNow = useCallback(() => {
    if (statusRef.current !== "unlocked") return;
    tokens.current.access = undefined;
    setStatus("locked");
  }, [setStatus]);

  const signOut = useCallback(async () => {
    const rt = tokens.current.refresh;
    if (rt) {
      await Promise.race([
        api.logout(rt).catch(() => {}),
        new Promise((r) => setTimeout(r, 3000)),
      ]);
    }
    await endSession(null);
  }, [endSession]);

  // Boot: version gate, then restore the stored session (locked until biometric passes).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const v = await api.appVersion(APP_VERSION);
        if (v.updateRequired || compareVersions(APP_VERSION, v.minimumVersion) < 0) {
          if (!alive) return;
          setUpdate(v);
          setStatus("updateRequired");
          return;
        }
      } catch {
        // offline at boot: carry on, the gate is re-checked on the next launch
      }
      const [rt, profile] = await Promise.all([
        secure.loadRefresh().catch(() => null),
        secure.loadProfile().catch(() => null),
      ]);
      if (!alive) return;
      if (rt && profile) {
        tokens.current = { refresh: rt };
        lockLimit.current = profile.autoLockSeconds;
        setAutoLockSeconds(profile.autoLockSeconds);
        setApprovalThreshold(profile.biometricApprovalAboveCents ?? null);
        setUser(profile.user);
        setStatus("locked");
      } else {
        setStatus("signedOut");
      }
    })();
    return () => {
      alive = false;
    };
  }, [setStatus]);

  // Auto-lock after the app sat in the background past the limit.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (isAuthenticating()) return;
      if (next === "background") {
        backgroundedAt.current = Date.now();
      } else if (next === "active") {
        if (shouldLock(backgroundedAt.current, Date.now(), lockLimit.current)) lockNow();
        backgroundedAt.current = null;
      }
    });
    return () => sub.remove();
  }, [lockNow]);

  const value = useMemo<AuthCtx>(
    () => ({
      status,
      user,
      offline,
      notice,
      update,
      autoLockSeconds,
      approvalBiometricAboveCents,
      signIn,
      verifyOtp,
      unlock,
      lockNow,
      signOut,
      request,
    }),
    [status, user, offline, notice, update, autoLockSeconds, approvalBiometricAboveCents, signIn, verifyOtp, unlock, lockNow, signOut, request],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
