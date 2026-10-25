// Pure shape mapping for sign-in payloads. Kept apart from auth.js (which needs the axios client) so the client itself can
// use it when it refreshes a session without importing itself in a circle.

/** The new server's person -> the legacy `user` object the screens read (name, 0/1 flags, `permissions` as a list of keys). */
export function adaptUser(user, uiPermissions = []) {
  return {
    id: user.id,
    username: user.username,
    name: user.displayName,
    email: user.email ?? null,
    phone: user.phone ?? null,
    role: user.role,
    is_active: user.active ? 1 : 0,
    must_change_password: user.mustChangePassword ? 1 : 0,
    two_factor_enabled: user.twoFactorEnabled ? 1 : 0,
    has_pin: Boolean(user.hasPin),
    last_login_at: user.lastLoginAt ?? null,
    created_at: user.createdAt ?? null,
    // The Staff access keys the screens ask about (user.permissions.includes('reports.view')). Admin is always allowed by the UI.
    permissions: uiPermissions,
  };
}

/**
 * { token, user, session } as the legacy login, refresh and /me answer. Safe to call on a legacy payload: anything that
 * already looks legacy (has `name`) or has no person in it passes through untouched.
 */
export function adaptSessionPayload(data) {
  if (!data || !data.user || data.user.name !== undefined) return data;
  const out = { user: adaptUser(data.user, data.uiPermissions), session: data.session ?? null };
  if (data.token !== undefined) out.token = data.token;
  return out;
}
