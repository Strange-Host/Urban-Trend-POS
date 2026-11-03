import { ApiError } from "./errors";
import type {
  Api,
  ApiErrorBody,
  ApiErrorCode,
  AppVersionInfo,
  HomeAttention,
  HomeSummary,
  MobileLoginResponse,
  TokenPair,
} from "./types";

const KNOWN: ApiErrorCode[] = [
  "INVALID_CREDENTIALS",
  "TOKEN_EXPIRED",
  "REFRESH_INVALID",
  "DEVICE_REVOKED",
  "FORBIDDEN",
];

async function call<T>(
  base: string,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError("NETWORK", "No connection", 0);
  }
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const body = json as Partial<ApiErrorBody> | null;
    const raw = body?.error?.code as ApiErrorCode | undefined;
    const code = raw && KNOWN.includes(raw) ? raw : "UNKNOWN";
    throw new ApiError(code, body?.error?.message ?? `HTTP ${res.status}`, res.status);
  }
  return json as T;
}

export function createHttpApi(base: string): Api {
  return {
    login: (req) =>
      call<MobileLoginResponse>(base, "POST", "/auth/mobile/login", { body: req }),
    refresh: (refreshToken) =>
      call<TokenPair>(base, "POST", "/auth/mobile/refresh", { body: { refreshToken } }),
    logout: (refreshToken) =>
      call<void>(base, "POST", "/auth/mobile/logout", { body: { refreshToken } }),
    registerDevice: (token, body) => call<void>(base, "POST", "/devices", { token, body }),
    homeAttention: (token) => call<HomeAttention>(base, "GET", "/home/attention", { token }),
    homeSummary: (token) => call<HomeSummary>(base, "GET", "/home/summary", { token }),
    appVersion: () => call<AppVersionInfo>(base, "GET", "/app/version"),
  };
}
