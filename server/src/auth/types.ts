import type { Role } from './permissions.js';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
  sessionId: number;
  email?: string | null;
  /** This person's individual differences from their role's defaults, keyed by the Staff access editor's keys. */
  overrides?: Record<string, boolean>;
  /** Seconds since the password or PIN was last typed in this session ("confirm it's you"). */
  reauthSeconds?: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: AuthUser; sessionPolicy?: import('./settings.js').SessionPolicy }
  }
}
