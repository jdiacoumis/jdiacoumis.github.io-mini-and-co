// Modular end-to-end runner: stages the public assets, boots ONE fresh
// `wrangler dev` (free port, fresh local D1 with migrations + seed) and runs
// every journey in test/e2e/journeys/*.js in file-name order. Run with:
//
//   npm run e2e                     # every journey
//   npm run e2e -- core-parent plan # journeys whose file name contains a filter
//
// A journey is a module exporting `async function run(ctx)` (and optionally
// `title`). It uses the ctx helpers below and records results with
// ctx.check(name, condition, detail). Journeys share one server and one
// database, so each uses its own email addresses. Phase 1 journeys are named
// core-*.js; Phase 2 areas add parent-*.js, admin-*.js, ops-*.js.
//
// ctx:
//   base                         'http://127.0.0.1:<port>'
//   fetch(path, { method, body, headers, cookie, ip })
//        → { status, location, text, headers, cookie }   (redirects not followed;
//          body: string | URLSearchParams | FormData | object (form-encoded);
//          cookie: 'session=…' from signIn; ip: CF-Connecting-IP to present)
//   signIn(email)          → session cookie ('session=…'), via the dev mailbox
//   csrfFor(cookie)        → that session's CSRF token
//   check(name, cond, detail)
//   section(title)         prints a heading
//   form(object | pairs)   → URLSearchParams (array values repeat the key)
//   field(html, name)      → value of the first <input name=… value=…>
//   mailbox(email)         → [{ subject, body }] newest first (dev outbox)
//   sql(query)             → rows (read-only, straight from the dev database)
//   sqlWrite(query)        → runs a write against the dev database (test setup
//                            such as "time passes"); use sparingly
//   runCron()              → triggers the Worker's scheduled() handler
//   sydneyDate(daysFromNow)→ 'YYYY-MM-DD' in Australia/Sydney
//   repo                   path of the repository root

import { spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { stageAssets } from '../../scripts/stage-assets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); // booking/
const REPO = join(ROOT, '..');
const JOURNEYS_DIR = join(ROOT, 'test', 'e2e', 'journeys');
const filters = process.argv.slice(2);

// Private files that exist on disk but must never be published (site-
// publishing spec). Created for the run if absent, removed afterwards — a
// file that already existed (e.g. a real .DS_Store) is left alone.
const PROBES = [
  { path: join(REPO, 'business', 'zz-probe.md'), content: '# private probe — must never be served\n' },
  { path: join(REPO, '.DS_Store'), content: 'probe' },
];
const createdProbes = [];
const createdDirs = [];

function placeProbes() {
  for (const probe of PROBES) {
    if (existsSync(probe.path)) continue;
    const dir = dirname(probe.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      createdDirs.push(dir);
    }
    writeFileSync(probe.path, probe.content);
    createdProbes.push(probe.path);
  }
}

function removeProbes() {
  for (const path of createdProbes) rmSync(path, { force: true });
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function sydneyDate(daysFromNow = 0) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + daysFromNow * 86400e3));
}

function toForm(entries) {
  const params = new URLSearchParams();
  const pairs = Array.isArray(entries) ? entries : Object.entries(entries);
  for (const [key, value] of pairs) {
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v));
    else if (value !== undefined && value !== null) params.append(key, String(value));
  }
  return params;
}

function findDatabaseFile(stateDir) {
  const dir = join(stateDir, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  const file = readdirSync(dir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite');
  if (!file) throw new Error('local D1 database file not found');
  return join(dir, file);
}

function makeCtx({ base, dbFile, results }) {
  let signIns = 0;

  const ctx = {
    base,
    repo: REPO,

    async fetch(path, { method = 'GET', body = null, headers = {}, cookie = null, ip = null } = {}) {
      const h = { ...headers };
      if (cookie) h.Cookie = cookie;
      if (ip) h['CF-Connecting-IP'] = ip;
      let payload = body;
      if (body && !(typeof body === 'string') && !(body instanceof URLSearchParams) && !(body instanceof FormData)) {
        payload = toForm(body);
      }
      if (payload instanceof URLSearchParams) payload = payload.toString();
      if (typeof payload === 'string' && !h['Content-Type']) h['Content-Type'] = 'application/x-www-form-urlencoded';
      const res = await fetch(`${base}${path}`, { method, body: payload, headers: h, redirect: 'manual' });
      const setCookie = res.headers.get('Set-Cookie');
      return {
        status: res.status,
        location: res.headers.get('Location') || '',
        text: await res.text(),
        headers: res.headers,
        cookie: setCookie ? setCookie.split(';')[0] : null,
      };
    },

    // Magic-link sign-in through the dev mailbox. Each sign-in presents its
    // own client IP so the per-IP sign-in limits are not shared by journeys.
    async signIn(email) {
      signIns += 1;
      const ip = `10.99.${Math.floor(signIns / 200)}.${(signIns % 200) + 1}`;
      const request = await ctx.fetch('/auth/request-magic-link', { method: 'POST', body: { email }, ip });
      if (request.status !== 200) throw new Error(`magic link request failed for ${email} (HTTP ${request.status})`);
      const mailbox = await ctx.fetch(`/dev/mailbox?to=${encodeURIComponent(email)}`);
      const token = /\/auth\/verify\?token=([A-Za-z0-9_-]+)/.exec(mailbox.text)?.[1];
      if (!token) throw new Error(`no magic link found for ${email}`);
      const verify = await ctx.fetch('/auth/verify', { method: 'POST', body: { token }, ip });
      if (verify.status !== 303 || !verify.cookie) throw new Error(`sign-in failed for ${email} (HTTP ${verify.status})`);
      return verify.cookie;
    },

    async csrfFor(cookie) {
      const page = await ctx.fetch('/account/profile', { cookie });
      const token = ctx.field(page.text, 'csrf');
      if (!token) throw new Error('no CSRF token on /account/profile');
      return token;
    },

    check(name, condition, detail = '') {
      if (condition) {
        results.passed += 1;
        console.log(`  ok   ${name}`);
      } else {
        results.failed += 1;
        results.failures.push(name);
        console.error(`  FAIL ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`);
      }
      return Boolean(condition);
    },

    section(title) {
      console.log(`\n${title}:`);
    },

    form: toForm,

    field(html, name) {
      const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
      return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
    },

    async mailbox(email) {
      return ctx.sql(`SELECT subject, body_text AS body FROM dev_emails WHERE to_email = '${String(email).replace(/'/g, "''")}' ORDER BY id DESC`);
    },

    sql(query) {
      const out = execFileSync('sqlite3', ['-json', '-readonly', dbFile, query], { encoding: 'utf8' }).trim();
      return out ? JSON.parse(out) : [];
    },

    sqlWrite(query) {
      execFileSync('sqlite3', [dbFile, query], { encoding: 'utf8' });
    },

    // wrangler dev --test-scheduled exposes /__scheduled, which calls the
    // Worker's scheduled() handler in-process. (Wrangler 4.86's
    // /cdn-cgi/handler/scheduled route fails in dev with Workers Assets: its
    // proxy cannot serialise the ScheduledController.)
    async runCron() {
      const res = await fetch(`${base}/__scheduled?cron=${encodeURIComponent('*/15 * * * *')}`);
      await res.text();
      return res.status;
    },

    sydneyDate,
  };
  return ctx;
}

async function main() {
  const journeyFiles = readdirSync(JOURNEYS_DIR)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => !filters.length || filters.some((needle) => f.includes(needle)))
    .sort();
  if (!journeyFiles.length) throw new Error(`no journeys match ${filters.join(', ')}`);

  placeProbes();
  stageAssets({ log: () => {} });

  const stateDir = mkdtempSync(join(tmpdir(), 'miniandco-e2e-'));
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  console.log('Applying migrations + seed to a fresh database…');
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'miniandco-booking', '--local', '--persist-to', stateDir], { cwd: ROOT, stdio: 'ignore', env });
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'miniandco-booking', '--local', '--persist-to', stateDir, '--file', 'seed/dev-seed.sql'], { cwd: ROOT, stdio: 'ignore', env });
  const dbFile = findDatabaseFile(stateDir);

  const [port, inspectorPort] = [await freePort(), await freePort()];
  const base = `http://127.0.0.1:${port}`;
  console.log(`Starting wrangler dev on :${port}…`);
  const server = spawn('npx', [
    'wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(inspectorPort),
    '--persist-to', stateDir, '--test-scheduled',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env, detached: true });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  const results = { passed: 0, failed: 0, failures: [] };
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i += 1) {
      try {
        const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
        up = res.ok;
      } catch { /* not up yet */ }
      if (!up) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!up) throw new Error(`server did not become ready; log tail:\n${serverLog.slice(-2000)}`);

    const ctx = makeCtx({ base, dbFile, results });
    for (const file of journeyFiles) {
      const journey = await import(pathToFileURL(join(JOURNEYS_DIR, file)).href);
      console.log(`\n=== ${journey.title || file} (${file})`);
      try {
        await journey.run(ctx);
      } catch (err) {
        results.failed += 1;
        results.failures.push(`${file} crashed`);
        console.error(`  FAIL ${file} crashed — ${err && err.stack ? err.stack : err}`);
      }
    }
  } finally {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
    removeProbes();
    await new Promise((r) => setTimeout(r, 1500));
    try { process.kill(-server.pid, 'SIGKILL'); } catch { /* already gone */ }
    rmSync(stateDir, { recursive: true, force: true });
  }

  console.log(`\n${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) {
    console.error(`Failed: ${results.failures.join('; ')}`);
    console.error(`\nServer log tail:\n${serverLog.slice(-3000)}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('E2E run crashed:', err);
  removeProbes();
  process.exitCode = 1;
});
