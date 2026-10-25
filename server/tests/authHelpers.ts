import request from 'supertest';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import { createUser } from '../src/auth/service.js';
import type { Role } from '../src/auth/permissions.js';
import type { Pool } from '../src/db/pool.js';

export const appFor = (pool: Pool, sessionHours = 12) => createApp({ pool, logger: createLogger('silent'), sessionHours });

let n = 0;
/** A user whose one-time password has already been changed, logged in. Returns the bearer header ready to use. */
export async function loggedIn(pool: Pool, role: Role, opts: { keepTemporary?: boolean } = {}) {
  const app = appFor(pool);
  const username = `${role}${++n}x${Math.random().toString(36).slice(2, 6)}`;
  const { user, temporaryPassword } = await createUser(pool, { username, displayName: `Test ${role}`, role, actor: 'test-setup' });
  const first = await request(app).post('/api/auth/login').send({ username, password: temporaryPassword });
  let token: string = first.body.token;
  let password = temporaryPassword;
  if (!opts.keepTemporary) {
    password = `Better-${Math.random().toString(36).slice(2, 12)}-pw`;
    const ch = await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${token}`).send({ currentPassword: temporaryPassword, newPassword: password });
    if (ch.status !== 200) throw new Error(`change-password failed: ${JSON.stringify(ch.body)}`);
  }
  return { app, user, username, password, token, auth: `Bearer ${token}`, temporaryPassword };
}
