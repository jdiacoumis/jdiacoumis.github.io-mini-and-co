// Shared test helpers: a real D1 database via miniflare (bundled with
// wrangler — no extra dependency), with the project migration applied.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const MIGRATION_PATH = fileURLToPath(new URL('../../migrations/0001_init.sql', import.meta.url));

export async function createTestDb() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'unit-test-db' },
  });
  const db = await mf.getD1Database('DB');

  const sql = await readFile(MIGRATION_PATH, 'utf8');
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.prepare(statement).run();
  }

  return {
    env: { DB: db },
    dispose: () => mf.dispose(),
  };
}
