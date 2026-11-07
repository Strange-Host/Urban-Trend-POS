// The server answers every auth problem with a 401 and does not name which kind. The app's session handling needs to
// tell them apart (refresh and retry, or sign out), so the meaning comes from the status plus which call failed:
//   - the sign-in call: 401 is a wrong email or password;
//   - the refresh call: 401 means the refresh token is no good (used twice, session ended, account changed);
//   - any other signed-in call: a bare 401 is an access token that ran out (refresh once and retry), while the server's
//     own SESSION_EXPIRED means the sign-in itself was ended (the owner revoked the phone, or it was signed out elsewhere).
export type CallKind = "public" | "login" | "refresh" | "authed";

export function mapErrorCode(status: number, raw: string | undefined, kind: CallKind): string | undefined {
  if (status === 401) {
    if (kind === "login") return "INVALID_CREDENTIALS";
    if (kind === "refresh") return "REFRESH_INVALID";
    if (kind === "authed") return raw === "SESSION_EXPIRED" ? "DEVICE_REVOKED" : "TOKEN_EXPIRED";
  }
  return raw;
}
