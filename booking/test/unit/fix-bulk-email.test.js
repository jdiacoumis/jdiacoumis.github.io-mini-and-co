// Review fix (task 3.2, D1 limits): a bulk email to a large audience used to
// go out in one request — two database writes and a Resend call per family,
// past Cloudflare's per-request caps. It now goes out twelve at a time; the
// page carries on by itself (js/admin-continue.js) or with Continue, and a
// failing address is only retried when the owner presses Try again.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm, signedIn, formRequest, outcome, routeHandler, iso, countingEnv } from './helpers.js';
import * as adminEmail from '../../src/routes/admin-email.js';

const { env, dispose } = await createTestDb();
after(() => dispose());
const run = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).run();

test('a large audience is emailed in steps of twelve, each within the per-request limits', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'bk' });
  for (let i = 0; i < 15; i += 1) {
    await run(`INSERT INTO users (id, email, name, created_at) VALUES (?1, ?2, ?3, ?4)`, `bk-u${i}`, `bk-${i}@example.com`, `Parent ${i}`, iso(Date.now()));
    await run(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES (?1, ?2, 'Kid', '2026-01-01', ?3)`, `bk-c${i}`, `bk-u${i}`, iso(Date.now()));
    await run(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, created_at) VALUES (?1, ?2, ?3, 'casual', ?4, 'confirmed', 3000, ?5)`,
      `bk-b${i}`, `bk-u${i}`, `bk-c${i}`, fam.termId, iso(Date.now()));
    await run(`INSERT INTO booking_sessions (booking_id, session_id) VALUES (?1, ?2)`, `bk-b${i}`, fam.sessionIds[0]);
  }
  const owner = await signedIn(env, 'owner@example.com');
  const batch = crypto.randomUUID();
  const message = { audience: 'term', term: fam.termId, subject: 'Hall change', body: 'We are in the big hall this week.' };
  const send = (extra = {}, e = env) => outcome(routeHandler(adminEmail, 'POST', '/admin/email/send')(formRequest('POST', '/admin/email/send', {
    cookie: owner.cookie, form: { csrf: owner.csrf, ...message, batch, ...extra },
  }), e, {}));
  const delivered = async () => (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM email_log WHERE template = 'bulk' AND subject = 'Hall change' AND status = 'sent'`,
  ).first()).n;

  // Measured as in production: Resend over fetch (the dev outbox would add
  // a database write per email).
  const counted = countingEnv({ ...env, EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: `re_${crypto.randomUUID()}` });
  let first;
  try {
    first = await (await send({}, counted.env)).text();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(counted.stats.statements <= 40, JSON.stringify(counted.stats));
  assert.equal(await delivered(), adminEmail.BULK_PER_REQUEST);
  assert.match(first, /data-auto-continue/);
  assert.match(first, /<script src="\/js\/admin-continue.js" defer><\/script>/);
  assert.match(first, /Continue \(3 left\)/);
  const already = /name="already" value="(\d+)"/.exec(first)[1];

  const last = await (await send({ step: 'continue', already })).text();
  assert.equal(await delivered(), 15);
  assert.match(last, /Sent to 15 families\./);
  assert.doesNotMatch(last, /data-auto-continue/);

  const again = await (await send()).text();
  assert.match(again, /Sent to 0 families\. 15 already had this email/);
  assert.equal(await delivered(), 15, 'nobody twice');
});

test('a failing address is not retried by the automatic Continue — only by Try again', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'bf' });
  await run(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, created_at) VALUES ('bf-b', ?1, ?2, 'casual', ?3, 'confirmed', 3000, ?4)`,
    fam.userId, fam.childId, fam.termId, iso(Date.now()));
  await run(`INSERT INTO booking_sessions (booking_id, session_id) VALUES ('bf-b', ?1)`, fam.sessionIds[0]);
  const owner = await signedIn(env, 'owner@example.com');
  const batch = crypto.randomUUID();
  const form = { csrf: owner.csrf, audience: 'term', term: fam.termId, subject: 'Note', body: 'Hello', batch };
  const send = (extra, e) => outcome(routeHandler(adminEmail, 'POST', '/admin/email/send')(formRequest('POST', '/admin/email/send', {
    cookie: owner.cookie, form: { ...form, ...extra },
  }), e, {}));
  const broken = await (await send({}, { ...env, EMAIL_DRIVER: 'broken' })).text();
  assert.match(broken, /couldn't be sent/);
  const cont = await (await send({ step: 'continue', already: '0' }, env)).text();
  assert.match(cont, /couldn't be sent/, 'Continue leaves the failed one alone');
  const retried = await (await send({}, env)).text();
  assert.match(retried, /Sent to 1 family\./);
});
