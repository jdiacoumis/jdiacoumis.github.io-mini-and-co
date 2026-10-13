// Notifications (idempotent email log) and the scheduled-job registry (D10).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm, daysFromNow, iso } from './helpers.js';
import { sendTemplate, notifyOwner } from '../../src/lib/notify.js';
import { runJobs, allJobs } from '../../src/lib/cron.js';
import { expireOffers, purgeOldRecords } from '../../src/lib/jobs/core.js';
import { prepareBooking, createPendingBooking } from '../../src/lib/domain.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const count = async (sql, ...binds) => (await env.DB.prepare(sql).bind(...binds).first()).n;

test('sendTemplate logs every send and skips a repeated dedupe key', async () => {
  const message = { template: 'reminder', to: 'Parent@Example.com', subject: 'See you tomorrow', text: 'Hi', html: '<p>Hi</p>' };
  const first = await sendTemplate(env, { ...message, dedupeKey: 'reminder:s1:b1' });
  const second = await sendTemplate(env, { ...message, dedupeKey: 'reminder:s1:b1' });
  assert.equal(first.sent, true);
  assert.deepEqual(second, { skipped: true });
  assert.equal(await count(`SELECT COUNT(*) AS n FROM email_log WHERE dedupe_key = 'reminder:s1:b1'`), 1);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = 'parent@example.com'`), 1, 'one email delivered');

  // Without a key every call sends.
  await sendTemplate(env, { ...message, to: 'other@example.com' });
  await sendTemplate(env, { ...message, to: 'other@example.com' });
  assert.equal(await count(`SELECT COUNT(*) AS n FROM email_log WHERE to_email = 'other@example.com'`), 2);
  assert.equal((await sendTemplate(env, { ...message, to: 'not-an-email' })).error, 'invalid_recipient');
});

test('a failed send is logged as failed and retried by the next run', async () => {
  const broken = { ...env, EMAIL_DRIVER: 'nope' };
  const message = { template: 'offer', to: 'retry@example.com', subject: 'Offer', text: 'x', dedupeKey: 'offer:w1' };
  assert.deepEqual(await sendTemplate(broken, message), { sent: false, error: 'send_failed' });
  const failed = await env.DB.prepare(`SELECT status, error FROM email_log WHERE dedupe_key = 'offer:w1'`).first();
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Unknown EMAIL_DRIVER/);
  assert.equal((await sendTemplate(env, message)).sent, true);
  assert.equal((await sendTemplate(env, message)).skipped, true);
});

test('notifyOwner emails every ADMIN_EMAILS address, once per dedupe key', async () => {
  const owners = { ...env, ADMIN_EMAILS: 'one@example.com, two@example.com' };
  await notifyOwner(owners, 'Heads up', 'Something happened', { dedupeKey: 'alert:x' });
  await notifyOwner(owners, 'Heads up', 'Something happened', { dedupeKey: 'alert:x' });
  assert.equal(await count(`SELECT COUNT(*) AS n FROM email_log WHERE dedupe_key LIKE 'alert:x:%'`), 2);
  const subject = await env.DB.prepare(`SELECT subject FROM dev_emails WHERE to_email = 'two@example.com'`).first();
  assert.equal(subject.subject, '[Mini & Co. bookings] Heads up');
});

test('the job registry runs every job and isolates failures', async () => {
  assert.deepEqual(allJobs().map((j) => j.name).slice(0, 3), ['sweepExpiredBookings', 'expireOffers', 'purge']);
  const ran = [];
  const results = await runJobs(env, {
    jobs: [
      { name: 'boom', run: async () => { throw new Error('kaput'); } },
      { name: 'fine', run: async (_env, { now }) => { ran.push(now); return { ok: 1 }; } },
    ],
    now: '2027-01-01T00:00:00Z',
  });
  assert.deepEqual(results.map((r) => [r.name, r.ok]), [['boom', false], ['fine', true]]);
  assert.deepEqual(ran, ['2027-01-01T00:00:00Z']);
  assert.equal(results[0].error, 'kaput');
  const only = await runJobs(env, { only: ['purge'] });
  assert.deepEqual(only.map((r) => r.name), ['purge']);
});

test('expireOffers returns lapsed offers to waiting and releases their seat; paid offers become booked', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'cr', children: 2 });
  const hold = async (childId, sessionIds) => {
    const prepared = await prepareBooking(env, { userId: fam.userId, childId, kind: 'casual', termId: fam.termId, sessionIds, admin: true });
    return createPendingBooking(env, {
      userId: fam.userId, childId, kind: 'casual', termId: fam.termId, sessionIds, quote: prepared.quote, expiresAt: daysFromNow(2),
    });
  };
  const lapsed = await hold(fam.childIds[0], [fam.sessionIds[0]]);
  const paid = await hold(fam.childIds[1], [fam.sessionIds[0]]);
  await env.DB.prepare(`UPDATE bookings SET status = 'confirmed' WHERE id = ?1`).bind(paid.id).run();
  const past = daysFromNow(-0.01);
  for (const [id, childId, bookingId] of [['wl-1', fam.childIds[0], lapsed.id], ['wl-2', fam.childIds[1], paid.id]]) {
    await env.DB.prepare(
      `INSERT INTO waitlist (id, term_id, user_id, child_id, status, joined_at, offered_at, offer_expires_at, offer_booking_id)
       VALUES (?1, ?2, ?3, ?4, 'offered', ?5, ?5, ?6, ?7)`,
    ).bind(id, fam.termId, fam.userId, childId, daysFromNow(-3), past, bookingId).run();
  }
  const now = iso(Date.now());
  assert.deepEqual(await expireOffers(env, { now }), { lapsed: 1, booked: 1 });
  assert.deepEqual(await expireOffers(env, { now }), { lapsed: 0, booked: 0 }, 'idempotent');
  const entry = await env.DB.prepare(`SELECT status, note, offer_booking_id FROM waitlist WHERE id = 'wl-1'`).first();
  assert.equal(entry.status, 'waiting');
  assert.match(entry.note, /Offer lapsed/);
  assert.equal(entry.offer_booking_id, lapsed.id, 'kept, so a late payment still marks it booked');
  assert.equal((await env.DB.prepare(`SELECT status FROM bookings WHERE id = ?1`).bind(lapsed.id).first()).status, 'expired');
  assert.equal((await env.DB.prepare(`SELECT status FROM waitlist WHERE id = 'wl-2'`).first()).status, 'booked');
});

test('purge removes records older than 30 days only', async () => {
  const old = '2020-01-01T00:00:00Z';
  const fresh = iso(Date.now());
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO auth_tokens (token_hash, email, expires_at, created_at) VALUES ('old', 'a@example.com', ?1, ?1), ('new', 'a@example.com', ?2, ?2)`).bind(old, fresh),
    env.DB.prepare(`INSERT INTO webhook_events (event_id, status, received_at) VALUES ('evt_old', 'done', ?1), ('evt_new', 'done', ?2)`).bind(old, fresh),
    env.DB.prepare(`INSERT INTO rate_limits (key, window_start, count) VALUES ('k:60', '1577836800', 1), ('k:60', ?1, 1)`).bind(String(Math.floor(Date.now() / 1000))),
  ]);
  const result = await purgeOldRecords(env, { now: fresh });
  assert.equal(result.tokens, 1);
  assert.equal(result.webhookEvents, 1);
  assert.equal(result.rateLimits, 1);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM auth_tokens WHERE token_hash = 'new'`), 1);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM webhook_events WHERE event_id = 'evt_new'`), 1);
});
