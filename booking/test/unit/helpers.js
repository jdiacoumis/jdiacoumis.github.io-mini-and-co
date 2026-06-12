// Shared test helpers: a real D1 database via miniflare (bundled with
// wrangler — no extra dependency), with the project migration applied.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export async function createTestDb() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'unit-test-db' },
  });
  const db = await mf.getD1Database('DB');

  const migrations = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of migrations) {
    const sql = await readFile(`${MIGRATIONS_DIR}${file}`, 'utf8');
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
  }

  return {
    env: { DB: db },
    dispose: () => mf.dispose(),
  };
}
