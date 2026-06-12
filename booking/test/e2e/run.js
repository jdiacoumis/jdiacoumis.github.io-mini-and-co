// Scripted end-to-end journey against a real `wrangler dev` instance with a
// fresh local D1 database. Run with: npm run e2e
//
// Covers:
//   * Parent: magic link (scanner-safe POST verify) → child profile →
//     waiver/consent checkout → mock payment → confirmed page with Purchase
//     pixel data → status API.
//   * Admin: class + weekly-repeat session creation → roster with snapshot →
//     CSV import preview/commit → invites → exports.
//   * Security smoke: asset exposure (worker source, specs → 404), IDOR
//     isolation, CSRF rejection, admin denial for parents.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = process.env.E2E_PORT || '8799';
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- Tiny session-aware client (cookies + CSRF scraping) ---------------------

function makeClient() {
  const client = {
    cookie: null,
    async request(path, { method = 'GET', body = null, headers = {} } = {}) {
      const h = { ...headers };
      if (client.cookie) h.Cookie = client.cookie;
      if (body && typeof body === 'string' && !h['Content-Type']) h['Content-Type'] = 'application/x-www-form-urlencoded';
      const res = await fetch(`${BASE}${path}`, { method, body, headers: h, redirect: 'manual' });
      const setCookie = res.headers.get('Set-Cookie');
      if (setCookie) client.cookie = setCookie.split(';')[0];
      const text = await res.text();
      return { status: res.status, location: res.headers.get('Location') || '', text, headers: res.headers };
    },
  };
  return client;
}

function field(html, name) {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  return m ? m[1] : '';
}

function form(entries) {
  return new URLSearchParams(entries).toString();
}

// Sign in via magic link: request → read link from the dev mailbox → POST.
async function signIn(client, email) {
  await client.request('/auth/request-magic-link', { method: 'POST', body: form({ email }) });
  const mailbox = await client.request('/dev/mailbox');
  const tokens = [...mailbox.text.matchAll(/\/auth\/verify\?token=([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  if (!tokens.length) throw new Error(`no magic link found for ${email}`);
  const verify = await client.request('/auth/verify', { method: 'POST', body: form({ token: tokens[0] }) });
  if (verify.status !== 303) throw new Error(`sign-in failed for ${email} (HTTP ${verify.status})`);
}

// --- Boot a fresh server ------------------------------------------------------

const stateDir = mkdtempSync(join(tmpdir(), 'miniandco-e2e-'));
console.log('Applying migrations + seed to a fresh database…');
execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'miniandco-booking', '--local', '--persist-to', stateDir], { cwd: ROOT, stdio: 'ignore' });
execFileSync('npx', ['wrangler', 'd1', 'execute', 'miniandco-booking', '--local', '--persist-to', stateDir, '--file', 'seed/dev-seed.sql'], { cwd: ROOT, stdio: 'ignore' });

console.log(`Starting wrangler dev on :${PORT}…`);
const server = spawn('npx', ['wrangler', 'dev', '--port', PORT, '--persist-to', stateDir], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server did not become ready; log tail:\n${serverLog.slice(-2000)}`);
}

async function main() {
  await waitForServer();

  // ---- Asset exposure ----
  console.log('\nAsset exposure:');
  for (const path of ['/booking/src/index.js', '/booking/wrangler.toml', '/booking/.dev.vars',
    '/openspec/project.md', '/CLAUDE.md', '/scripts/export-banner.py', '/.git/config']) {
    const res = await fetch(`${BASE}${path}`);
    check(`${path} → 404`, res.status === 404, `got ${res.status}`);
  }
  for (const path of ['/css/booking.css', '/js/booking-status.js', '/js/booking-pixel.js', '/css/styles.css']) {
    const res = await fetch(`${BASE}${path}`);
    check(`${path} → 200`, res.status === 200, `got ${res.status}`);
  }

  // ---- Parent journey ----
  console.log('\nParent journey:');
  const parent = makeClient();
  await signIn(parent, 'e2e-parent@example.com');
  const account = await parent.request('/account');
  check('signed in to /account', account.status === 200 && account.text.includes('e2e-parent@example.com'));

  // Add a child (explicit consent required).
  const addForm = await parent.request('/account/children/new');
  const csrf = field(addForm.text, 'csrf');
  const noConsent = await parent.request('/account/children/new', {
    method: 'POST',
    body: form({ csrf, name: 'Edie', dob: '2025-11-20', medical: 'Dairy intolerance' }),
  });
  check('child without consent choice rejected', noConsent.status === 400 && noConsent.text.includes('value="Edie"'));
  const added = await parent.request('/account/children/new', {
    method: 'POST',
    body: form({ csrf, name: 'Edie', dob: '2025-11-20', medical: 'Dairy intolerance', photo_consent: 'yes' }),
  });
  check('child created', added.status === 303);

  // Pick two sessions from the class list and walk the waiver step.
  const list = await parent.request('/book');
  const sessions = [...list.text.matchAll(/name="session" value="([^"]+)"/g)].map((m) => m[1]).slice(0, 2);
  check('class list offers sessions', sessions.length === 2);
  check('class list groups sessions by term', list.text.includes('Term 3'));
  check('class list offers whole-term booking', list.text.includes('Book the full term'));
  check('class list offers a single-class trial', list.text.includes('Try a single class first'));
  const checkoutQs = sessions.map((s) => `session=${encodeURIComponent(s)}`).join('&');
  const review = await parent.request(`/book/checkout?${checkoutQs}`);
  check('checkout shows waiver + total', review.text.includes('Waiver') && review.text.includes('$50.00'));
  check('checkout fires InitiateCheckout hook', review.text.includes('data-pixel-page="checkout"'));

  const noWaiver = await parent.request('/book/checkout', {
    method: 'POST',
    body: form({ csrf, child: field(review.text, 'child'), session: sessions[0], photo_consent: 'yes', medical: '' }),
  });
  check('payment blocked without waiver acceptance', noWaiver.status === 400);

  const pay = await parent.request('/book/checkout', {
    method: 'POST',
    body: `${form({ csrf, child: field(review.text, 'child'), photo_consent: 'yes', medical: 'Dairy intolerance', waiver: 'accepted' })}&${checkoutQs.replace(/session=/g, 'session=')}`,
  });
  check('checkout redirects to payment', pay.status === 303 && pay.location.includes('/dev/mock-checkout'), pay.location);
  const bookingId = /booking=([a-f0-9-]+)/.exec(pay.location)?.[1];

  const pendingConfirm = await parent.request(`/book/confirm?booking=${bookingId}`);
  check('confirmation reflects pending payment', pendingConfirm.text.includes('data-poll-booking'));

  const mock = await parent.request(`/dev/mock-checkout?booking=${bookingId}`);
  const paid = await parent.request('/dev/mock-checkout', {
    method: 'POST',
    body: form({ csrf: field(mock.text, 'csrf'), booking: bookingId, outcome: 'success' }),
  });
  check('mock payment succeeds', paid.status === 303);

  const confirm = await parent.request(`/book/confirm?booking=${bookingId}`);
  check('confirmation shows paid state', confirm.text.includes('Paid: $50.00 AUD'));
  check('Purchase pixel data present once paid',
    confirm.text.includes('data-pixel-purchase') && confirm.text.includes(`data-booking-id="${bookingId}"`));
  const status = await parent.request(`/api/bookings/${bookingId}/status`);
  check('status API reports confirmed', status.text.includes('"confirmed"'));
  const mailbox = await parent.request('/dev/mailbox');
  check('confirmation email sent', mailbox.text.includes('Booking confirmed'));

  // Double-booking the same child into the same session must be refused —
  // both at the checkout review (GET) and at booking creation (POST).
  const dupReview = await parent.request(`/book/checkout?session=${encodeURIComponent(sessions[0])}`);
  check('checkout refuses an already-booked session', dupReview.status === 409 && dupReview.text.includes('Already booked'));
  const dupPost = await parent.request('/book/checkout', {
    method: 'POST',
    body: form({ csrf, child: field(review.text, 'child'), session: sessions[0], photo_consent: 'yes', medical: '', waiver: 'accepted' }),
  });
  check('booking creation refuses a duplicate child+session', dupPost.status === 409);

  const accountPage = await parent.request('/account');
  check('account page leads with the booking CTA', /page-head[\s\S]{0,200}Book a class/.test(accountPage.text));

  // ---- Isolation + CSRF ----
  console.log('\nIsolation and CSRF:');
  const stranger = makeClient();
  await signIn(stranger, 'e2e-stranger@example.com');
  const idor = await stranger.request(`/book/confirm?booking=${bookingId}`);
  check("another account can't read the booking", idor.status === 404);
  const idorApi = await stranger.request(`/api/bookings/${bookingId}/status`);
  check("another account can't read booking status", idorApi.status === 404);
  const adminDenied = await stranger.request('/admin');
  check('parent denied admin area', adminDenied.status === 403);
  const badCsrf = await parent.request('/account/children/new', {
    method: 'POST',
    body: form({ csrf: 'forged', name: 'X', dob: '2025-11-20', photo_consent: 'no' }),
  });
  check('forged CSRF token rejected', badCsrf.status === 403);

  // ---- Admin journey ----
  console.log('\nAdmin journey:');
  const admin = makeClient();
  await signIn(admin, 'miniandco.classes@gmail.com'); // ADMIN_EMAILS in .dev.vars
  const dash = await admin.request('/admin');
  check('admin dashboard lists fullness', dash.status === 200 && /\d+\/\d+/.test(dash.text));

  const classesPage = await admin.request('/admin/classes/new');
  const adminCsrf = field(classesPage.text, 'csrf');
  const newClass = await admin.request('/admin/classes/new', {
    method: 'POST',
    body: form({ csrf: adminCsrf, name: 'E2E Class', description: 'Test', venue: 'Test Hall', age_range: '0-1' }),
  });
  check('class created', newClass.status === 303);

  const sessionsPage = await admin.request('/admin/sessions/new');
  const classId = /name="class_id"[\s\S]*?value="([^"]+)"[^>]*>E2E Class/.exec(sessionsPage.text)?.[1];
  const repeat = await admin.request('/admin/sessions/new', {
    method: 'POST',
    body: form({ csrf: adminCsrf, class_id: classId, date: '2026-09-23', time: '09:30', duration: '45', capacity: '8', price: '25', repeat: '4' }),
  });
  check('weekly repeat created', repeat.status === 303);
  const dash2 = await admin.request('/admin');
  const niner = (dash2.text.match(/9:30\s?am/gi) || []).length;
  check('4 repeated sessions render at 9:30 am Sydney', niner >= 4, `found ${niner}`);

  // Roster for the booked session shows the snapshot.
  const roster = await admin.request(`/admin/sessions/${sessions[0]}/roster`);
  check('roster shows child + snapshot + paid', roster.text.includes('Edie')
    && roster.text.includes('Dairy intolerance') && roster.text.includes('Paid'));
  const rosterCsv = await admin.request(`/admin/sessions/${sessions[0]}/roster.csv`, {
    method: 'POST', body: form({ csrf: adminCsrf }),
  });
  check('roster CSV exports', rosterCsv.status === 200 && rosterCsv.text.includes('"Edie"'));

  // Import: preview → commit → invites.
  const csv = 'parent_name,parent_email,parent_phone,child_name,child_dob,medical_notes,photo_consent\n'
    + 'Import Parent,e2e-import@example.com,0400000000,Remy,2025-07-07,,yes\n'
    + 'Bad Row,not-an-email,,Kid,2025-07-07,,yes\n';
  const fd = new FormData();
  fd.set('csrf', adminCsrf);
  fd.set('file', new File([csv], 'import.csv', { type: 'text/csv' }));
  const preview = await admin.request('/admin/import/preview', { method: 'POST', body: fd });
  check('import preview: 1 valid, 1 invalid', preview.text.includes('1 of 2 row'));
  const payload = field(preview.text, 'payload');
  const commit = await admin.request('/admin/import/commit', {
    method: 'POST', body: form({ csrf: adminCsrf, payload }),
  });
  check('import commit reports outcomes', commit.text.includes('Imported'));
  const invites = await admin.request('/admin/import/invites', {
    method: 'POST', body: form({ csrf: adminCsrf, payload }),
  });
  check('invites sent to imported parent', invites.text.includes('e2e-import@example.com') && invites.text.includes('Invite sent'));

  const bookingsCsv = await admin.request('/admin/bookings.csv', { method: 'POST', body: form({ csrf: adminCsrf }) });
  check('bookings CSV exports', bookingsCsv.status === 200 && bookingsCsv.text.startsWith('"Created"'));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`\nServer log tail:\n${serverLog.slice(-1500)}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('E2E run crashed:', err);
    console.error(`Server log tail:\n${serverLog.slice(-1500)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill('SIGTERM');
    setTimeout(() => {
      try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
      process.exit();
    }, 1500);
  });
