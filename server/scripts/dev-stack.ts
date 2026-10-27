import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { createApp } from '../src/app.js';
import { createUser } from '../src/auth/service.js';
import { hashPassword } from '../src/auth/password.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { createLogger } from '../src/logger.js';

// The whole new server with nothing to install or configure: an embedded PostgreSQL (thrown away on exit), the migrations, three
// sample accounts, and the API on PORT (default 3000). For trying the staff screens against the new server on your own machine:
//   terminal 1:  npm run dev:stack
//   terminal 2:  cd ../frontend && VITE_USE_NEW_SERVER=true npm run dev
// Not for production: the database is temporary and the passwords below are public.
const PORT = Number(process.env.PORT ?? 3000);
const ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3000').split(',').map((o) => o.trim()).filter(Boolean);

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

const dir = mkdtempSync(path.join(tmpdir(), 'utpos-dev-'));
const pgPort = await freePort();
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: pgPort, persistent: false, createPostgresUser: true, onLog: () => undefined, onError: () => undefined });
await pg.initialise();
await pg.start();
await pg.createDatabase('utpos');
const pool = createPool(`postgres://postgres:postgres@localhost:${pgPort}/utpos`, { max: 5 });
await runMigrations(pool);

export const ACCOUNTS = [
  { username: 'admin', role: 'admin' as const, email: 'admin@shop.test', password: 'Admin-Dev-Passphrase-1' },
  { username: 'manager', role: 'manager' as const, email: 'manager@shop.test', password: 'Manager-Dev-Passphrase-1' },
  { username: 'cashier', role: 'cashier' as const, email: 'cashier@shop.test', password: 'Cashier-dev-1', pin: '4829' },
];
for (const a of ACCOUNTS) {
  const { user } = await createUser(pool, { username: a.username, displayName: `${a.username[0]!.toUpperCase()}${a.username.slice(1)} (sample)`, role: a.role, email: a.email, pin: a.pin, actor: 'dev-stack' });
  await pool.query(`UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1`, [user.id, await hashPassword(a.password)]);
}

const server = createApp({ pool, logger: createLogger('warn'), orderRefKey: process.env.ORDER_REF_KEY ?? 'dev-stack-order-reference-key-not-for-production-0123456789', corsOrigins: ORIGINS, trustProxyHops: 0, signInLimit: false }).listen(PORT, () => {
  // One machine-readable line, so a test runner can wait for it.
  console.log(`READY ${JSON.stringify({ api: `http://localhost:${PORT}/api`, accounts: ACCOUNTS.map(({ email, password, role, pin }) => ({ email, password, role, pin })) })}`);
});

async function stop() {
  server.close();
  await pool.end().catch(() => undefined);
  await pg.stop().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
