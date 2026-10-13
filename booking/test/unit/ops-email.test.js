// Bulk email and the email log (routes/admin-email.js): audiences (one email
// per parent), preview, send deduped on the batch, validation, and admin-only
// routes with CSRF on every POST.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm, daysFromNow, iso } from './helpers.js';
import {
  audienceRecipients, sendBulk, readCompose, templateLabel, registerRoutes, SUBJECT_MAX,
} from '../../src/routes/admin-email.js';
import { createSession } from '../../src/lib/session.js';
import { HttpError } from '../../src/lib/http.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const run = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).run();
const one = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).first();
const count = async (sql, ...binds) => (await one(sql, ...binds)).n;

async function family(prefix, children = 1) {
  await run(`INSERT INTO users (id, email, name, created_at) VALUES (?1, ?2, ?3, ?4)`,
    `${prefix}-u`, `${prefix}@example.com`, `${prefix} parent`, iso(Date.now()));
  const ids = [];
  for (let i = 0; i < children; i += 1) {
    await run(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES (?1, ?2, ?3, '2026-02-01', ?4)`,
      `${prefix}-c${i}`, `${prefix}-u`, `${prefix} kid ${i}`, iso(Date.now()));
    ids.push(`${prefix}-c${i}`);
  }
  return { userId: `${prefix}-u`, childIds: ids };
}

async function booking(id, f, childId, termId, sessionIds, { status = 'confirmed', expiresAt = null } = {}) {
  await run(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, created_at, expires_at)
             VALUES (?1, ?2, ?3, 'casual', ?4, ?5, 3000, ?6, ?7)`, id, f.userId, childId, termId, status, iso(Date.now()), expiresAt);
  for (const s of sessionIds) await run(`INSERT INTO booking_sessions (booking_id, session_id) VALUES (?1, ?2)`, id, s);
}

let fixture;
async function setup() {
  if (fixture) return fixture;
  const term = await seedFamilyAndTerm(env, { prefix: 'em', children: 2 }); // em@example.com: 2 children
  const past = await seedFamilyAndTerm(env, { prefix: 'emp', startInDays: -60 });
  const two = await family('em-two');
  const held = await family('em-held');
  const gone = await family('em-gone');
  const lapsed = await family('em-lapsed');
  const waiting = await family('em-wait');
  const parentOfTwo = { userId: term.userId };
  await booking('em-b1', parentOfTwo, term.childIds[0], term.termId, [term.sessionIds[0]]);
  await booking('em-b2', parentOfTwo, term.childIds[1], term.termId, [term.sessionIds[1]]);
  await booking('em-b3', two, two.childIds[0], term.termId, [term.sessionIds[2]]);
  await booking('em-b4', held, held.childIds[0], term.termId, [term.sessionIds[3]], { status: 'pending', expiresAt: daysFromNow(1) });
  await booking('em-b5', gone, gone.childIds[0], term.termId, [term.sessionIds[4]], { status: 'cancelled' });
  await booking('em-b6', lapsed, lapsed.childIds[0], term.termId, [term.sessionIds[5]], { status: 'pending', expiresAt: daysFromNow(-1) });
  await booking('em-b7', { userId: past.userId }, past.childId, past.termId, [past.sessionIds[0]]); // all weeks long gone
  await run(`INSERT INTO waitlist (id, term_id, user_id, child_id, status, joined_at) VALUES ('em-w1', ?1, ?2, ?3, 'waiting', ?4)`,
    term.termId, waiting.userId, waiting.childIds[0], iso(Date.now()));
  await run(`INSERT INTO waitlist (id, term_id, user_id, child_id, status, joined_at) VALUES ('em-w2', ?1, ?2, ?3, 'removed', ?4)`,
    term.termId, gone.userId, gone.childIds[0], iso(Date.now()));
  fixture = { term, past };
  return fixture;
}

test("a term's families: live bookings only, one entry per parent with every child", async () => {
  const { term } = await setup();
  const recipients = await audienceRecipients(env, { audience: 'term', termId: term.termId });
  assert.deepEqual(recipients.map((r) => r.email).sort(), ['em-held@example.com', 'em-two@example.com', 'em@example.com']);
  const parent = recipients.find((r) => r.email === 'em@example.com');
  assert.deepEqual(parent.children.sort(), ['Child 0', 'Child 1']);
});

test("a term's waitlist, and all current families", async () => {
  const { term, past } = await setup();
  const waitlist = await audienceRecipients(env, { audience: 'waitlist', termId: term.termId });
  assert.deepEqual(waitlist.map((r) => r.email), ['em-wait@example.com']);
  const everyone = (await audienceRecipients(env, { audience: 'all' })).map((r) => r.email);
  for (const email of ['em@example.com', 'em-two@example.com', 'em-held@example.com']) assert.ok(everyone.includes(email), email);
  for (const email of ['em-gone@example.com', 'em-lapsed@example.com', 'emp@example.com']) assert.ok(!everyone.includes(email), email);
  assert.deepEqual(await audienceRecipients(env, { audience: 'term', termId: past.termId }).then((r) => r.map((x) => x.email)),
    ['emp@example.com'], "a past term's families are still its families");
  assert.deepEqual(await audienceRecipients(env, { audience: 'nobody' }), []);
});

test('sending a batch emails each parent once; repeating the batch sends nothing', async () => {
  const { term } = await setup();
  const recipients = await audienceRecipients(env, { audience: 'term', termId: term.termId });
  const batch = crypto.randomUUID();
  const first = await sendBulk(env, { batchId: batch, recipients, subject: 'Theme change', bodyText: 'Hello\n\nSee you Wednesday', termId: term.termId });
  assert.deepEqual([first.sent, first.skipped, first.failed], [3, 0, 0]);
  const again = await sendBulk(env, { batchId: batch, recipients, subject: 'Theme change', bodyText: 'Hello', termId: term.termId });
  assert.deepEqual([again.sent, again.skipped, again.failed], [0, 3, 0]);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = 'em@example.com' AND subject = 'Theme change'`), 1);
  const mail = await one(`SELECT body_text FROM dev_emails WHERE to_email = 'em-two@example.com' AND subject = 'Theme change'`);
  assert.ok(mail.body_text.startsWith('Hi em-two,\n\nHello\n\nSee you Wednesday'), 'first name, then the message');
  const log = await one(`SELECT template, term_id, user_id FROM email_log WHERE dedupe_key = ?1`, `bulk:${batch}:${term.userId}`);
  assert.deepEqual(log, { template: 'bulk', term_id: term.termId, user_id: term.userId });
});

test('compose validation', () => {
  const read = (fields) => readCompose((name) => fields[name] ?? null);
  const ok = { audience: 'term', term: 't-1', subject: '  Hello\tthere ', body: 'Line one\r\nLine two' };
  assert.deepEqual(read(ok), { values: { audience: 'term', term: 't-1', subject: 'Hello there', body: 'Line one\nLine two' }, error: null });
  assert.match(read({ ...ok, audience: 'everyone' }).error, /who should get/);
  assert.match(read({ ...ok, term: '' }).error, /choose a term/);
  assert.equal(read({ ...ok, audience: 'all', term: '' }).error, null, 'no term needed for everyone');
  assert.match(read({ ...ok, subject: '' }).error, /subject/);
  assert.match(read({ ...ok, subject: 'x'.repeat(SUBJECT_MAX + 1) }).error, /under 150/);
  assert.match(read({ ...ok, body: ' \n ' }).error, /write your message/);
  assert.match(read({ ...ok, body: 'x'.repeat(5001) }).error, /under 5000/);
  assert.equal(templateLabel('reminder'), 'Class reminder (day before)');
  assert.equal(templateLabel('something_new'), 'something new');
});

// --- Routes ------------------------------------------------------------------

const routes = [];
registerRoutes((method, pattern, handler) => routes.push({ method, pattern, handler }));
const route = (method, pattern) => routes.find((r) => r.method === method && r.pattern === pattern).handler;

async function account(email) {
  const id = `acct-${email}`;
  await run(`INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?1, ?2, ?3)`, id, email, iso(Date.now()));
  const session = await createSession(env, id);
  return { cookie: `session=${session.sessionId}`, csrf: session.csrfToken };
}

function request(method, path, { cookie = null, form = null } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  return new Request(`http://localhost:8787${path}`, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined });
}

async function outcome(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof Response || err instanceof HttpError) return err;
    throw err;
  }
}

test('every email route is admin-only, and every POST needs the CSRF token', async () => {
  const parent = await account('em-route-parent@example.com');
  const admin = await account('owner@example.com');
  assert.equal(routes.length, 4);
  for (const r of routes) {
    const anon = await outcome(r.handler(request(r.method, r.pattern, { form: r.method === 'POST' ? {} : null }), env, {}));
    assert.ok(anon instanceof Response && anon.status === 303, `${r.method} ${r.pattern} signed out`);
    assert.equal(anon.headers.get('Location'), `/auth/request-magic-link?next=${encodeURIComponent(r.pattern)}`,
      `${r.method} ${r.pattern} sends a signed-out visitor to sign in, then back`);
    const denied = await outcome(r.handler(request(r.method, r.pattern, { cookie: parent.cookie, form: r.method === 'POST' ? { csrf: parent.csrf } : null }), env, {}));
    assert.ok(denied instanceof HttpError && denied.status === 403, `${r.method} ${r.pattern} as a parent`);
    if (r.method === 'POST') {
      const forged = await outcome(r.handler(request('POST', r.pattern, { cookie: admin.cookie, form: { csrf: 'nope' } }), env, {}));
      assert.ok(forged instanceof HttpError && forged.status === 403, `${r.pattern} without CSRF`);
    }
  }
});

test('preview shows the count and an escaped sample; send delivers once; the log lists every recipient', async () => {
  const { term } = await setup();
  const admin = await account('owner@example.com');
  const message = { audience: 'term', term: term.termId, subject: 'Picnic <day>', body: 'Bring a <b>hat</b>.\n\nSee you there' };

  const compose = await route('GET', '/admin/email')(request('GET', `/admin/email?audience=waitlist&term=${term.termId}`, { cookie: admin.cookie }), env, {});
  const composeBody = await compose.text();
  assert.ok(composeBody.includes('value="waitlist" checked'));
  assert.ok(composeBody.includes(`value="${term.termId}" selected`));

  const invalid = await route('POST', '/admin/email/preview')(request('POST', '/admin/email/preview', { cookie: admin.cookie, form: { csrf: admin.csrf, ...message, subject: '' } }), env, {});
  assert.equal(invalid.status, 400);

  const preview = await route('POST', '/admin/email/preview')(request('POST', '/admin/email/preview', { cookie: admin.cookie, form: { csrf: admin.csrf, ...message } }), env, {});
  const html = await preview.text();
  assert.equal(preview.status, 200);
  assert.ok(html.includes('<strong>3 families</strong>'));
  assert.ok(html.includes('Send to 3 families'));
  assert.ok(html.includes('Subject: <strong>Picnic &lt;day&gt;</strong>'));
  assert.ok(html.includes('Bring a &lt;b&gt;hat&lt;/b&gt;.') && !html.includes('<b>hat</b>'));
  const [sample] = await audienceRecipients(env, { audience: 'term', termId: term.termId });
  assert.ok(html.includes(`<p>Hi ${sample.parentName.split(' ')[0] || 'there'},</p>`), 'greets the first recipient by first name');
  assert.ok(html.includes(`To: ${sample.email}`));
  const batch = /name="batch" value="([^"]+)"/.exec(html)[1];
  assert.equal(await count(`SELECT COUNT(*) AS n FROM dev_emails WHERE subject = 'Picnic <day>'`), 0, 'a preview sends nothing');

  const send = () => route('POST', '/admin/email/send')(request('POST', '/admin/email/send', { cookie: admin.cookie, form: { csrf: admin.csrf, ...message, batch } }), env, {});
  const sent = await (await send()).text();
  assert.ok(sent.includes('Sent to 3 families.'));
  const resent = await (await send()).text();
  assert.ok(resent.includes('Sent to 0 families. 3 already had this email'));
  assert.equal(await count(`SELECT COUNT(*) AS n FROM dev_emails WHERE subject = 'Picnic <day>'`), 3);
  const expired = await route('POST', '/admin/email/send')(request('POST', '/admin/email/send', { cookie: admin.cookie, form: { csrf: admin.csrf, ...message, batch: '../x' } }), env, {});
  assert.equal(expired.status, 400);

  const log = await route('GET', '/admin/email/log')(request('GET', `/admin/email/log?template=bulk&term=${term.termId}&q=EM-TWO`, { cookie: admin.cookie }), env, {});
  const logHtml = await log.text();
  assert.equal(log.status, 200);
  for (const page of [composeBody, html, sent, logHtml]) {
    assert.ok(!/\bundefined\b|\bnull\b|\[object /.test(page.replace(/<[^>]*>/g, ' ')), 'no rendering artefacts');
  }
  assert.ok(logHtml.includes('em-two@example.com'));
  assert.ok(!logHtml.includes('em-held@example.com'), 'the address filter applies');
  assert.ok(logHtml.includes('Your message to families'));
  assert.ok(logHtml.includes('Picnic &lt;day&gt;'));
  const all = await (await route('GET', '/admin/email/log')(request('GET', '/admin/email/log?template=bulk&q=%25', { cookie: admin.cookie }), env, {})).text();
  assert.ok(all.includes('No emails match.'), 'a % in the search is literal');
});
