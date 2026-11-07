import assert from "node:assert/strict";
import { test } from "node:test";
import { toSession, type RawSession } from "./adapters";
import { mapErrorCode } from "./errorMap";
import { needsBiometric } from "../lib/approvals";
import { entityTarget, parseDeepLink } from "../lib/deeplink";
import { isOtpChallenge } from "./types";

test("error mapping: the server's bare 401s get the meaning the session code needs", () => {
  // signing in
  assert.equal(mapErrorCode(401, "UNAUTHORIZED", "login"), "INVALID_CREDENTIALS");
  assert.equal(mapErrorCode(429, "ACCOUNT_LOCKED", "login"), "ACCOUNT_LOCKED");
  // refreshing: any 401 (invalid, reused, session ended) means sign in again
  assert.equal(mapErrorCode(401, "UNAUTHORIZED", "refresh"), "REFRESH_INVALID");
  assert.equal(mapErrorCode(401, "SESSION_EXPIRED", "refresh"), "REFRESH_INVALID");
  // any other signed-in call: a bare 401 is an expired access token, SESSION_EXPIRED is an ended sign-in
  assert.equal(mapErrorCode(401, "UNAUTHORIZED", "authed"), "TOKEN_EXPIRED");
  assert.equal(mapErrorCode(401, undefined, "authed"), "TOKEN_EXPIRED");
  assert.equal(mapErrorCode(401, "SESSION_EXPIRED", "authed"), "DEVICE_REVOKED");
  // everything else keeps the server's code
  assert.equal(mapErrorCode(403, "BIOMETRIC_REQUIRED", "authed"), "BIOMETRIC_REQUIRED");
  assert.equal(mapErrorCode(403, "PASSWORD_CHANGE_REQUIRED", "authed"), "PASSWORD_CHANGE_REQUIRED");
  assert.equal(mapErrorCode(409, "DUPLICATE_PHONE", "authed"), "DUPLICATE_PHONE");
  assert.equal(mapErrorCode(401, "UNAUTHORIZED", "public"), "UNAUTHORIZED");
});

test("session adapter: token becomes accessToken, settings are filled in, null means never ask", () => {
  const raw: RawSession = {
    token: "a", refreshToken: "r",
    user: { id: 1, name: "J", email: "j@x.test", role: "admin", permissions: ["reports.view"] },
    session: { id: 9, expiresAt: "2030-01-01T00:00:00.000Z" },
  };
  const s = toSession(raw);
  assert.equal(s.accessToken, "a");
  assert.equal(s.refreshToken, "r");
  assert.equal(s.sessionId, 9);
  assert.equal(s.settings.autoLockSeconds, 120);
  assert.equal(s.settings.biometricApprovalAboveCents, null);
  assert.equal(toSession({ ...raw, settings: { autoLockSeconds: 60, biometricApprovalAboveCents: 500_000 } }).settings.biometricApprovalAboveCents, 500_000);
  assert.equal(isOtpChallenge(s), false);
  assert.equal(isOtpChallenge({ twoFactorRequired: true, challengeToken: "c", phoneHint: "07", expiresInSeconds: 1 }), true);
});

test("biometric rule matches the server: at or above the limit, null never", () => {
  assert.equal(needsBiometric(500_000, 500_000), true); // equal counts
  assert.equal(needsBiometric(499_999, 500_000), false);
  assert.equal(needsBiometric(10_000_000, null), false);
  assert.equal(needsBiometric(null, 0), true); // a limit of 0 asks for everything
  assert.equal(needsBiometric(null, 500_000), false);
});

test("entity links: what the server's '<entity>:<id>' opens", () => {
  assert.deepEqual(parseDeepLink("order:41"), { kind: "order", id: 41 });
  assert.deepEqual(parseDeepLink("expense:12"), { kind: "approval", id: "expense:12" });
  assert.deepEqual(parseDeepLink("lead:7"), { kind: "route", name: "LeadDetail", params: { id: 7 } });
  assert.deepEqual(parseDeepLink("payment_notification:9"), { kind: "route", name: "Payments" });
  assert.deepEqual(parseDeepLink("approval:3"), { kind: "tab", tab: "Approvals" });
  assert.deepEqual(parseDeepLink("stock_take:5"), { kind: "route", name: "StockTakeDetail", params: { id: 5 } });
  // records the app has no screen for answer null, so the caller can say "opens on the website"
  assert.equal(parseDeepLink("stock_transfer:5"), null);
  assert.equal(entityTarget("petty_cash_topup", 1), null);
  assert.equal(entityTarget("security_event", 1), null);
  assert.equal(parseDeepLink(""), null);
});
