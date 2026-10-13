// Phase 3 integration fixes in communications: every email carries a
// Reply-To that reaches the owner, the owner hears when a waitlist offer
// lapses, the email log has a label for every template the code sends, and
// the pay-later email lives with the other templates.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTestDb, seedFamilyAndTerm, daysFromNow, iso } from './helpers.js';
import { sendEmail, defaultReplyTo } from '../../src/lib/email-driver.js';
import { sendTemplate } from '../../src/lib/notify.js';
import { expireOffers } from '../../src/lib/jobs/core.js';
import { prepareBooking, createPendingBooking } from '../../src/lib/domain.js';
import { TEMPLATE_LABELS } from '../../src/routes/admin-email.js';
import { payLaterHold } from '../../src/lib/emails/ops.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

test('the Reply-To is EMAIL_REPLY_TO, else the first ADMIN_EMAILS address', () => {
  assert.equal(defaultReplyTo({ EMAIL_REPLY_TO: ' Camila@Example.com ', ADMIN_EMAILS: 'owner@example.com' }), 'camila@example.com');
  assert.equal(defaultReplyTo({ EMAIL_REPLY_TO: '', ADMIN_EMAILS: 'owner@example.com, second@example.com' }), 'owner@example.com');
  assert.equal(defaultReplyTo({ EMAIL_REPLY_TO: 'not an address', ADMIN_EMAILS: 'owner@example.com' }), 'owner@example.com');
  assert.equal(defaultReplyTo({}), null);
});

test('Resend is asked to send replies to the owner', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 're_1' }), { status: 200 });
  };
  try {
    const resend = { EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM: 'Mini & Co. <bookings@example.com>' };
    await sendEmail({ ...resend, EMAIL_REPLY_TO: 'camila@example.com' }, 'parent@example.com', 'Hi', 'Body');
    await sendEmail({ ...resend, ADMIN_EMAILS: 'owner@example.com' }, 'parent@example.com', 'Hi', 'Body');
    await sendEmail({ ...resend, ADMIN_EMAILS: 'owner@example.com' }, 'parent@example.com', 'Hi', 'Body', '', { replyTo: null });
    await assert.rejects(sendEmail(resend, 'parent@example.com', 'Hi', 'Body', '', { replyTo: 'x\r\nBcc: evil@example.com' }), /replyTo/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].body.reply_to, 'camila@example.com');
  assert.equal(calls[1].body.reply_to, 'owner@example.com');
  assert.equal('reply_to' in calls[2].body, false, 'null means no Reply-To');
  assert.equal(calls[0].body.from, 'Mini & Co. <bookings@example.com>');
});

test('family emails sent through sendTemplate reply to the owner (dev outbox records it)', async () => {
  const outbox = (to) => env.DB.prepare(`SELECT reply_to FROM dev_emails WHERE to_email = ?1 ORDER BY id DESC`).bind(to).first();
  await sendTemplate(env, { template: 'reminder', to: 'family-a@example.com', subject: 'Reminder', text: 'Reply to this email.' });
  assert.equal((await outbox('family-a@example.com')).reply_to, 'owner@example.com', 'the first ADMIN_EMAILS address by default');
  await sendTemplate({ ...env, EMAIL_REPLY_TO: 'camila@example.com' }, {
    template: 'waitlist_offer', to: 'family-b@example.com', subject: 'Offer', text: 'Reply to let us know.',
  });
  assert.equal((await outbox('family-b@example.com')).reply_to, 'camila@example.com');
  const bad = await sendTemplate(env, { template: 'reminder', to: 'family-c@example.com', subject: 'x', text: 'x', replyTo: 'nope', dedupeKey: 'bad-reply' });
  assert.deepEqual(bad, { sent: false, error: 'send_failed' }, 'an invalid explicit Reply-To fails the send (logged, retried)');
});

test('a lapsed waitlist offer emails the owner once, naming the child and the waitlist page', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'cm-lapse', children: 2 });
  const hold = async (childId) => {
    const prepared = await prepareBooking(env, { userId: fam.userId, childId, kind: 'term', termId: fam.termId, admin: true });
    return createPendingBooking(env, {
      userId: fam.userId, childId, kind: 'term', termId: fam.termId, sessionIds: prepared.quote.sessionIds,
      quote: prepared.quote, expiresAt: daysFromNow(2),
    });
  };
  const lapsing = await hold(fam.childIds[0]);
  const paid = await hold(fam.childIds[1]);
  await env.DB.prepare(`UPDATE bookings SET status = 'confirmed' WHERE id = ?1`).bind(paid.id).run();
  for (const [id, childId, bookingId] of [['cm-w1', fam.childIds[0], lapsing.id], ['cm-w2', fam.childIds[1], paid.id]]) {
    await env.DB.prepare(
      `INSERT INTO waitlist (id, term_id, user_id, child_id, status, joined_at, offered_at, offer_expires_at, offer_booking_id)
       VALUES (?1, ?2, ?3, ?4, 'offered', ?5, ?5, ?6, ?7)`,
    ).bind(id, fam.termId, fam.userId, childId, daysFromNow(-3), daysFromNow(-0.01), bookingId).run();
  }
  const now = iso(Date.now());
  assert.deepEqual(await expireOffers(env, { now }), { lapsed: 1, booked: 1 });
  await expireOffers(env, { now });
  const alerts = (await env.DB.prepare(
    `SELECT dedupe_key, to_email, subject, booking_id, term_id FROM email_log WHERE template = 'owner_offer_lapsed'`,
  ).all()).results;
  assert.equal(alerts.length, 1, 'once, and only for the offer that lapsed');
  assert.equal(alerts[0].dedupe_key, `offer_lapsed:cm-w1:${lapsing.id}:owner@example.com`);
  assert.equal(alerts[0].booking_id, lapsing.id);
  assert.equal(alerts[0].term_id, fam.termId);
  assert.match(alerts[0].subject, /Waitlist offer lapsed — Child 0, Test Term/);
  const body = await env.DB.prepare(`SELECT body_text FROM dev_emails WHERE subject = ?1`).bind(alerts[0].subject).first();
  assert.ok(body.body_text.includes(`/admin/waitlist?term=${fam.termId}`));
  assert.ok(body.body_text.includes('back on the waitlist'));
});

test('the email log has an owner-facing label for every template the code sends', async () => {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(`${dir}${entry.name}/`);
      else if (entry.name.endsWith('.js')) files.push(`${dir}${entry.name}`);
    }
  };
  await walk(SRC);
  const used = new Set();
  for (const file of files) {
    for (const m of (await readFile(file, 'utf8')).matchAll(/template(?::|\s*=)\s*'([a-z_]+)'/g)) used.add(m[1]);
  }
  for (const name of ['booking_confirmed', 'reenrol_invitation', 'offline_receipt', 'pay_later_hold', 'trial_followup',
    'owner_waitlist_declined', 'owner_offer_lapsed', 'owner_alert']) {
    assert.ok(used.has(name), `${name} is sent somewhere`);
  }
  const missing = [...used].filter((name) => !Object.hasOwn(TEMPLATE_LABELS, name));
  assert.deepEqual(missing, [], 'templates without a label');
  const unused = Object.keys(TEMPLATE_LABELS).filter((name) => !used.has(name));
  assert.deepEqual(unused, [], 'labels for templates nothing sends');
});

test('payLaterHold: subject, amount, deadline, Pay now and the account link, escaped', () => {
  const m = payLaterHold({
    parentName: 'Priya Sharma', childName: '<b>Wren</b>', what: 'Term — Term 1 2027, Sensory Play', amountCents: 16800,
    expiresAt: '2027-02-17T02:00:00Z', accountUrl: 'https://example.com/account',
  });
  assert.equal(m.subject, "<b>Wren</b>'s place is saved — please pay by Wed, 17 Feb 2027");
  assert.ok(m.text.startsWith('Hi Priya,'));
  assert.ok(m.text.includes('press Pay now ($168.00) before Wed, 17 Feb 2027'));
  assert.ok(m.text.includes('https://example.com/account'));
  assert.ok(m.text.includes('reply to this email'));
  const html = String(m.html);
  assert.ok(html.includes('&lt;b&gt;Wren&lt;/b&gt;') && !html.includes('<b>Wren</b>'));
  assert.ok(html.includes('href="https://example.com/account"'));
});
