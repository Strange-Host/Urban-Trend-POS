import type { AppSettings, MobileLoginResponse, SessionUser } from "./types";

// What /auth/mobile/login, /auth/mobile/verify-otp and /auth/mobile/refresh send back.
export interface RawSession {
  token: string;
  refreshToken: string;
  user: SessionUser;
  session: { id: number; expiresAt: string };
  settings?: Partial<AppSettings>;
}

export const DEFAULT_SETTINGS: AppSettings = { autoLockSeconds: 120, biometricApprovalAboveCents: null };

export function toSession(raw: RawSession): MobileLoginResponse {
  return {
    accessToken: raw.token,
    refreshToken: raw.refreshToken,
    user: raw.user,
    settings: {
      autoLockSeconds: raw.settings?.autoLockSeconds ?? DEFAULT_SETTINGS.autoLockSeconds,
      biometricApprovalAboveCents: raw.settings?.biometricApprovalAboveCents ?? null,
    },
    sessionId: raw.session.id,
    sessionExpiresAt: raw.session.expiresAt,
  };
}
