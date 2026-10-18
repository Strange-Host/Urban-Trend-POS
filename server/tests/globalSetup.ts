import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GlobalSetupContext } from 'vitest/node';

// One Postgres for the whole test run. In CI, set TEST_DATABASE_URL to the service container and nothing is
// started here. Locally, an embedded Postgres is started on a free port, so `npm test` needs no setup at all.
// Each test file then makes its own database inside it (see helpers.ts), so files never see each other's data.
export default async function setup({ provide }: GlobalSetupContext) {
  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    provide('adminUrl', external);
    return;
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const { createServer } = await import('node:net');
  const port = await new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });

  const dir = mkdtempSync(path.join(tmpdir(), 'utpos-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false,
    createPostgresUser: true, // needed when the tests run as root (containers, this sandbox)
    onLog: () => undefined, onError: () => undefined,
  });
  await pg.initialise();
  await pg.start();
  provide('adminUrl', `postgres://postgres:postgres@localhost:${port}/postgres`);

  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
  }
}
