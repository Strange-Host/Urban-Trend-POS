import type { Role } from './permissions.js';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
  sessionId: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: AuthUser }
  }
}
