import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import useModules from '../hooks/useModules';

export default function ProtectedRoute({ children, roles, permission, module }) {
  const { user, initializing, can } = useAuth();
  const modules = useModules();
  const location = useLocation();

  // 2.3 — don't redirect to /login just because we don't know yet whether
  // there's a valid session; AuthContext is still trying the silent
  // refresh (see its boot effect). Redirecting here first and then
  // rendering the real page a moment later would flash the login screen
  // on every hard reload, even for someone who's genuinely still logged in.
  if (initializing) return null;

  if (!user) return <Navigate to="/login" replace />;

  // 2.1 — a temporary/one-time password blocks every backend route except
  // change-password/logout/me (see middleware/auth.js); mirror that here
  // so the person lands on the change-password screen directly instead of
  // a page that will just fail its first API call.
  if (user.must_change_password && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }

  // A page that belongs to an optional module (Settings > Business > Optional modules) is
  // unreachable while that module is off - by URL too, not just by menu. Wait for the answer first.
  if (module) {
    if (!modules.loaded) return null;
    if (!modules[module]) return <Navigate to="/" replace />;
  }

  // A route with a `permission` is decided by that permission alone (it already
  // includes the role default plus any per-person grant/revoke); otherwise by role.
  // `permission` may also be a list, meaning "holds at least one of these".
  if (permission) {
    const allowed = Array.isArray(permission) ? permission.some((p) => can(p)) : can(permission);
    if (!allowed) return <Navigate to="/" replace />;
  } else if (roles && !roles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return children;
}
