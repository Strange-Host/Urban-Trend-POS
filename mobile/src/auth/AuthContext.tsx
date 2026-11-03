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
import type { AppVersionInfo, SessionUser } from "../api/types";
import { authenticate, isAuthenticating } from "../lib/biometric";
import { compareVersions } from "../lib/format";
import { shouldLock } from "../lib/lock";
import { homeCache, secure } from "../lib/storage";

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
  signIn(username: string, password: string): Promise<void>;
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

const FATAL = new Set(["DEVICE_REVOKED", "REFRESH_INVALID"]);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatusState] = useState<AuthStatus>("booting");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [update, setUpdate] = useState<AppVersionInfo | null>(null);
  const [autoLockSeconds, setAutoLockSeconds] = useState(DEFAULT_AUTO_LOCK_SECONDS);

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
      await homeCache.clear().catch(() => {});
      setUser(null);
      setOffline(false);
      setNotice(message);
      setStatus("signedOut");
    },
    [setStatus],
  );

  const refreshTokens = useCallback((): Promise<string> => {
    if (refreshing.current) return refreshing.current;
    const rt = tokens.current.refresh;
    if (!rt) return Promise.reject(new ApiError("REFRESH_INVALID", "No session", 401));
    const p = api
      .refresh(rt)
      .then(async (pair) => {
        tokens.current = { access: pair.accessToken, refresh: pair.refreshToken };
        // rotation: the old refresh token is dead, persist the new one immediately
        await secure.saveRefresh(pair.refreshToken);
        return pair.accessToken;
      })
      .finally(() => {
        refreshing.current = null;
      });
    refreshing.current = p;
    return p;
  }, []);

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
            await endSession(
              e.code === "DEVICE_REVOKED"
                ? "This device was signed out. Sign in again."
                : "Your session ended. Sign in again.",
            );
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

  const signIn = useCallback(
    async (username: string, password: string) => {
      const device = {
        name: Device.deviceName ?? Device.modelName ?? "Android device",
        appVersion: APP_VERSION,
      };
      const res = await api.login({ username, password, device });
      tokens.current = { access: res.accessToken, refresh: res.refreshToken };
      await secure.saveRefresh(res.refreshToken);
      await secure.saveProfile({ user: res.user, autoLockSeconds: res.settings.autoLockSeconds });
      lockLimit.current = res.settings.autoLockSeconds;
      setAutoLockSeconds(res.settings.autoLockSeconds);
      setUser(res.user);
      setNotice(null);
      setOffline(false);
      setStatus("unlocked");
      // best effort; the push token is added when FCM is wired in
      api.registerDevice(res.accessToken, device).catch(() => {});
    },
    [setStatus],
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
        const v = await api.appVersion();
        if (compareVersions(APP_VERSION, v.minimumVersion) < 0) {
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
      signIn,
      unlock,
      lockNow,
      signOut,
      request,
    }),
    [status, user, offline, notice, update, autoLockSeconds, signIn, unlock, lockNow, signOut, request],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
