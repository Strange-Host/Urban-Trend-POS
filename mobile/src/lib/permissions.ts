import type { SessionUser } from "../api/types";

/** The owner can do everything; anyone else needs the permission key in the list the server sent at sign-in. */
export function can(user: SessionUser | null | undefined, perm: string | string[]): boolean {
  if (!user) return false;
  if (user.role === "owner") return true;
  const wanted = Array.isArray(perm) ? perm : [perm];
  return wanted.some((p) => user.permissions.includes(p));
}
