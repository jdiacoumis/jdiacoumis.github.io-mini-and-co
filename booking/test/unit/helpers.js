// Shared test helpers: a real D1 database via miniflare (bundled with
// wrangler — no extra dependency), with the project migrations applied, plus
// the development env vars the Worker reads.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

// Split a SQL script into statements: `--` comments (whole-line or trailing)
// are dropped and semicolons inside string literals do not split.
export function splitSql(sql) {
  const statements = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { current += "'"; i += 1; } else inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; current += ch; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      current += '\n';
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

export const DEV_VARS = {
  ENVIRONMENT: 'development',
  EMAIL_DRIVER: 'console',
  PAYMENTS_DRIVER: 'mock',
  PUBLIC_BASE_URL: 'http://localhost:8787',
  ADMIN_EMAILS: 'owner@example.com',
  STAFF_EMAILS: 'staff@example.com',
  WAIVER_VERSION: 'test-1',
};

export async function createTestDb(vars = {}) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: `unit-test-db-${crypto.randomUUID()}` },
  });
  const db = await mf.getD1Database('DB');

  const migrations = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of migrations) {
    for (const statement of splitSql(await readFile(`${MIGRATIONS_DIR}${file}`, 'utf8'))) {
      await db.prepare(statement).run();
    }
  }

  return {
    env: { DB: db, ...DEV_VARS, ...vars },
    dispose: () => mf.dispose(),
  };
}

// ISO instant helpers (second precision, like the app).
export function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function daysFromNow(days, base = Date.now()) {
  return iso(base + days * 86400e3);
}

// Insert a family, a class, a term and its weekly sessions. Returns ids.
export async function seedFamilyAndTerm(env, {
  prefix = 'x', capacity = 12, weeks = 6, startInDays = 3, termPrice = 16800, casual = 3000,
  trialPrice = null, returningPrice = null, previousTermId = null, planInstalments = 6,
  status = 'open', publicOpensAt = null, returningOpensAt = null, children = 1,
} = {}) {
  const now = iso(Date.now());
  const run = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).run();
  const userId = `${prefix}-user`;
  await run(`INSERT INTO users (id, email, created_at) VALUES (?1, ?2, ?3)`, userId, `${prefix}@example.com`, now);
  const childIds = [];
  for (let i = 0; i < children; i += 1) {
    const childId = `${prefix}-child-${i}`;
    childIds.push(childId);
    await run(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES (?1, ?2, ?3, '2025-10-01', ?4)`,
      childId, userId, `Child ${i}`, now);
  }
  const classId = `${prefix}-class`;
  await run(`INSERT INTO classes (id, name, weekday, start_time, created_at) VALUES (?1, 'Sensory Play', 3, '11:00', ?2)`, classId, now);
  const termId = `${prefix}-term`;
  await run(
    `INSERT INTO terms (id, class_id, name, starts_on, ends_on, term_price_cents, casual_price_cents,
                        trial_price_cents, returning_price_cents, returning_opens_at, public_opens_at,
                        previous_term_id, plan_instalments, plan_interval, status, created_at)
     VALUES (?1, ?2, 'Test Term', '2027-02-03', '2027-03-10', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'week', ?11, ?12)`,
    termId, classId, termPrice, casual, trialPrice, returningPrice, returningOpensAt, publicOpensAt,
    previousTermId, planInstalments, status, now,
  );
  const sessionIds = [];
  for (let w = 0; w < weeks; w += 1) {
    const id = `${prefix}-s${w + 1}`;
    sessionIds.push(id);
    await run(
      `INSERT INTO class_sessions (id, class_id, term_id, starts_at, capacity, casual_price_cents, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      id, classId, termId, daysFromNow(startInDays + 7 * w), capacity, casual, now,
    );
  }
  return { userId, childId: childIds[0], childIds, classId, termId, sessionIds };
}

// --- Route-level helpers ------------------------------------------------------

// A signed-in account (a web session minted directly): { userId, cookie, csrf }.
// ADMIN_EMAILS / STAFF_EMAILS in DEV_VARS decide what the address may do.
export async function signedIn(env, email, { name = '' } = {}) {
  const { createSession } = await import('../../src/lib/session.js');
  const userId = `acct-${email}`;
  await env.DB.prepare(`INSERT OR IGNORE INTO users (id, email, name, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(userId, email, name, iso(Date.now())).run();
  const row = await env.DB.prepare(`SELECT id FROM users WHERE email = ?1`).bind(email).first();
  const session = await createSession(env, row.id);
  return { userId: row.id, cookie: `session=${session.sessionId}`, csrf: session.csrfToken };
}

// A same-origin request as the browser would send it (form-encoded POST).
//   form: object | [[name, value], …] (repeat a name for several values)
export function formRequest(method, path, { cookie = null, form = null, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  let body;
  if (form) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    const params = new URLSearchParams();
    for (const [k, v] of Array.isArray(form) ? form : Object.entries(form)) {
      if (Array.isArray(v)) for (const x of v) params.append(k, String(x));
      else if (v !== undefined && v !== null) params.append(k, String(v));
    }
    body = params.toString();
  }
  return new Request(`http://localhost:8787${path}`, { method, headers: h, body });
}

// Run a route handler: thrown redirects (Response) and HttpErrors come back
// as values, like the router renders them.
export async function outcome(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof Response || (err && typeof err.status === 'number' && 'publicMessage' in err)) return err;
    throw err;
  }
}

// The handler a route module registers for (method, pattern).
export function routeHandler(module, method, pattern) {
  const routes = [];
  module.registerRoutes((m, p, handler) => routes.push({ m, p, handler }));
  const found = routes.find((r) => r.m === method && r.p === pattern);
  if (!found) throw new Error(`no route ${method} ${pattern}`);
  return found.handler;
}

// Count what a request asks of D1: `queries` (each run/all/first and each
// batch call) and `statements` (each batched statement counted on its own —
// the stricter reading of Cloudflare's per-request query limit).
export function countingEnv(env) {
  const stats = { queries: 0, batches: 0, statements: 0 };
  const wrap = (stmt) => new Proxy(stmt, {
    get(target, key) {
      if (key === 'bind') return (...args) => wrap(target.bind(...args));
      if (['run', 'all', 'first', 'raw'].includes(key)) {
        return (...args) => { stats.queries += 1; stats.statements += 1; return target[key](...args); };
      }
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const DB = new Proxy(env.DB, {
    get(target, key) {
      if (key === 'prepare') return (sql) => wrap(target.prepare(sql));
      if (key === 'batch') {
        return (list) => { stats.queries += 1; stats.batches += 1; stats.statements += list.length; return target.batch(list); };
      }
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...env, DB }, stats };
}
