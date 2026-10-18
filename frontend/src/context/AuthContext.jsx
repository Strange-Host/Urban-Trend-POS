import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { authApi } from '../api/endpoints';
import { setAccessToken, clearAccessToken, performRefresh, registerSessionHandlers, setFlash } from '../api/client';
import { markActive, markActiveIfNewer, sessionChannel } from '../api/sessionActivity';
import SessionGuard from '../components/SessionGuard';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // The sign-in session's rules from the server: when to lock, when it ends (see services/sessions.service.js).
  const [session, setSession] = useState(null);
  const [locked, setLocked] = useState(false);          // screen lock: nothing works until the password/PIN is entered
  const [reauthOpen, setReauthOpen] = useState(false);  // "confirm it's you" before a risky action
  // 2.3 — the access token no longer survives a reload (it's in memory
  // only, see api/client.js), so on boot there's a brief moment where we
  // don't yet know if the person is logged in. `initializing` lets
  // ProtectedRoute show a loading state instead of bouncing straight to
  // /login and then flashing back to the app a moment later once the
  // silent refresh below actually resolves.
  const [initializing, setInitializing] = useState(true);

  // Requests (and the app) waiting on an unlock / a confirmation. See registerSessionHandlers in api/client.js.
  const lockWaiters = useRef([]);
  const reauthWaiters = useRef([]);
  const settle = (list, ok, reason) => {
    const waiting = list.current;
    list.current = [];
    waiting.forEach((w) => (ok ? w.resolve() : w.reject(reason)));
  };

  const adoptSession = useCallback((s, { boot = false } = {}) => {
    setSession(s || null);
    if (!s) return;
    if (boot) {
      // A reload mid-day: pick the idle clock up from the server, which is the one that counts.
      markActiveIfNewer(Date.now() - (s.idleSeconds || 0) * 1000);
      if ((s.idleSeconds || 0) >= s.lockAfterSeconds) setLocked(true);
    } else {
      markActive();
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // The httpOnly refresh cookie is still there across a reload even
    // though the in-memory access token isn't — this silently exchanges
    // it for a fresh access token (and the current user) using the exact
    // same mechanism the request interceptor already uses for a routine
    // mid-session 401, so a hard refresh doesn't just log everyone out.
    performRefresh()
      .then((data) => { if (!cancelled) { setUser(data.user); adoptSession(data.session, { boot: true }); } })
      .catch((err) => {
        if (err?.response?.data?.error?.code === 'SESSION_EXPIRED') setFlash('You were signed out because the session ended. Please sign in again.');
      })
      .finally(() => { if (!cancelled) setInitializing(false); });
    return () => { cancelled = true; };
  }, [adoptSession]);

  const endLocalSession = useCallback(() => {
    clearAccessToken();
    setUser(null);
    setSession(null);
    setLocked(false);
    setReauthOpen(false);
    const err = new Error('signed out');
    settle(lockWaiters, false, err);
    settle(reauthWaiters, false, err);
  }, []);

  // Returns the signed-in user, OR — for an account with SMS sign-in codes on —
  // { twoFactorRequired: true, challengeToken, phoneHint } and NO session yet.
  // The caller then collects the code and calls verifyOtp().
  // `remember`: the "keep me signed in on this device" box (personal phones; never a shared till).
  const login = useCallback(async (email, password, remember = false) => {
    const { data } = await authApi.login(email, password, remember);
    if (data.twoFactorRequired) return data;
    // The refresh token is no longer here — it arrived as an httpOnly
    // Set-Cookie header the browser already stored; there's nothing for
    // JS to read or save for it.
    setAccessToken(data.token);
    setUser(data.user);
    adoptSession(data.session);
    return data.user;
  }, [adoptSession]);

  const verifyOtp = useCallback(async (challengeToken, code, remember = false) => {
    const { data } = await authApi.verifyOtp(challengeToken, code, remember);
    setAccessToken(data.token);
    setUser(data.user);
    adoptSession(data.session);
    return data.user;
  }, [adoptSession]);

  const logout = useCallback((message) => {
    // Best-effort — revoke the refresh token server-side (it reads the
    // cookie itself) so it can't be used again, but don't let a network
    // error block logging out locally.
    authApi.logout().catch(() => {});
    if (typeof message === 'string' && message) setFlash(message);
    sessionChannel()?.postMessage({ type: 'signed-out' });
    endLocalSession();
  }, [endLocalSession]);

  // Used after a forced password change (see ChangePassword.jsx) to
  // update the in-memory user (clears must_change_password) without a
  // full page reload — the endpoint itself already revoked the old
  // session, so the caller is expected to have logged in again first.
  const setCurrentUser = useCallback((updatedUser) => setUser(updatedUser), []);

  const lock = useCallback(() => {
    setLocked(true);
    sessionChannel()?.postMessage({ type: 'locked' });
  }, []);

  // Password or PIN typed on the lock screen or in the "confirm it's you" box. Same server call for both: it unlocks
  // the session and counts as a fresh confirmation. Throws the server's error (wrong password, locked out...) so the
  // form can show it.
  const confirmIdentity = useCallback(async (secret) => {
    const { data } = await authApi.unlock(secret);
    setSession(data.session);
    markActive();
    setLocked(false);
    setReauthOpen(false);
    settle(lockWaiters, true);
    settle(reauthWaiters, true);
    sessionChannel()?.postMessage({ type: 'unlocked' });
  }, []);

  const cancelReauth = useCallback(() => {
    setReauthOpen(false);
    settle(reauthWaiters, false, new Error('cancelled'));
  }, []);

  useEffect(() => {
    registerSessionHandlers({
      onLocked: () => new Promise((resolve, reject) => { lockWaiters.current.push({ resolve, reject }); setLocked(true); }),
      onReauth: () => new Promise((resolve, reject) => { reauthWaiters.current.push({ resolve, reject }); setReauthOpen(true); }),
    });
    return () => registerSessionHandlers({});
  }, []);

  // Other tabs of the same sign-in: lock together, unlock together, sign out together.
  useEffect(() => {
    const ch = sessionChannel();
    if (!ch) return undefined;
    const onMessage = (e) => {
      if (e.data?.type === 'locked') setLocked(true);
      if (e.data?.type === 'unlocked') { setLocked(false); settle(lockWaiters, true); }
      if (e.data?.type === 'signed-out') endLocalSession();
    };
    ch.addEventListener('message', onMessage);
    return () => ch.removeEventListener('message', onMessage);
  }, [endLocalSession]);

  const hasRole = useCallback((...roles) => !!user && roles.includes(user.role), [user]);

  // Permission-aware visibility. user.permissions is the server's EFFECTIVE list
  // (role defaults + any per-person grant/revoke); the server re-checks every
  // request, so this only decides what to show.
  const can = useCallback((permission) => !!user && (user.role === 'admin' || (user.permissions || []).includes(permission)), [user]);

  return (
    <AuthContext.Provider value={{
      user, session, locked, reauthOpen, initializing, login, verifyOtp, logout, hasRole, can, setCurrentUser,
      lock, confirmIdentity, cancelReauth,
    }}>
      {children}
      {user && <SessionGuard />}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
