import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { authApi } from '../api/endpoints';
import { setAccessToken, clearAccessToken, performRefresh } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // 2.3 — the access token no longer survives a reload (it's in memory
  // only, see api/client.js), so on boot there's a brief moment where we
  // don't yet know if the person is logged in. `initializing` lets
  // ProtectedRoute show a loading state instead of bouncing straight to
  // /login and then flashing back to the app a moment later once the
  // silent refresh below actually resolves.
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // The httpOnly refresh cookie is still there across a reload even
    // though the in-memory access token isn't — this silently exchanges
    // it for a fresh access token (and the current user) using the exact
    // same mechanism the request interceptor already uses for a routine
    // mid-session 401, so a hard refresh doesn't just log everyone out.
    performRefresh()
      .then((data) => { if (!cancelled) setUser(data.user); })
      .catch(() => { /* no valid cookie — genuinely logged out, nothing to do */ })
      .finally(() => { if (!cancelled) setInitializing(false); });
    return () => { cancelled = true; };
  }, []);

  // Returns the signed-in user, OR — for an account with SMS sign-in codes on —
  // { twoFactorRequired: true, challengeToken, phoneHint } and NO session yet.
  // The caller then collects the code and calls verifyOtp().
  const login = useCallback(async (email, password) => {
    const { data } = await authApi.login(email, password);
    if (data.twoFactorRequired) return data;
    // The refresh token is no longer here — it arrived as an httpOnly
    // Set-Cookie header the browser already stored; there's nothing for
    // JS to read or save for it.
    setAccessToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const verifyOtp = useCallback(async (challengeToken, code) => {
    const { data } = await authApi.verifyOtp(challengeToken, code);
    setAccessToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(() => {
    // Best-effort — revoke the refresh token server-side (it reads the
    // cookie itself) so it can't be used again, but don't let a network
    // error block logging out locally.
    authApi.logout().catch(() => {});
    clearAccessToken();
    setUser(null);
  }, []);

  // Used after a forced password change (see ChangePassword.jsx) to
  // update the in-memory user (clears must_change_password) without a
  // full page reload — the endpoint itself already revoked the old
  // session, so the caller is expected to have logged in again first.
  const setCurrentUser = useCallback((updatedUser) => setUser(updatedUser), []);

  const hasRole = useCallback((...roles) => !!user && roles.includes(user.role), [user]);

  // Permission-aware visibility. user.permissions is the server's EFFECTIVE list
  // (role defaults + any per-person grant/revoke); the server re-checks every
  // request, so this only decides what to show.
  const can = useCallback((permission) => !!user && (user.role === 'admin' || (user.permissions || []).includes(permission)), [user]);

  return (
    <AuthContext.Provider value={{ user, initializing, login, verifyOtp, logout, hasRole, can, setCurrentUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
