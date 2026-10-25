import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createPool, waitForDatabase } from '../db/pool.js';
import { createUser } from './service.js';

// Creates the first admin (or another one) from a shell, since nobody can log in to create it through the app.
//   npm run create-admin -- --username jon --name "Jon"
// On Railway: run `npm run create-admin:prod -- --username jon --name "Jon"` in the service shell.
// A random one-time password is printed once. There is no default password anywhere.
const { values } = parseArgs({ options: { username: { type: 'string' }, name: { type: 'string' } } });
if (!values.username) {
  console.error('Usage: npm run create-admin -- --username <username> [--name "Display Name"]');
  process.exit(2);
}

const config = loadConfig();
const pool = createPool(config.DATABASE_URL, { ssl: config.DATABASE_SSL === 'true', max: 2 });
try {
  await waitForDatabase(pool);
  const { user, temporaryPassword } = await createUser(pool, {
    username: values.username, displayName: values.name ?? values.username, role: 'admin', actor: 'create-admin-cli',
  });
  console.log(`Admin "${user.username}" created.`);
  console.log(`One-time password: ${temporaryPassword}`);
  console.log('It is shown only once. You will be asked to change it at first login.');
} catch (err) {
  console.error(`Could not create the admin: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
