// Trial follow-up job (lib/jobs/parent.js, design D10): the day after a
// trial class, one email offering the rest of the term at the pro-rata price
// — never twice, never too early, never when there is nothing to offer.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm, daysFromNow, iso } from './helpers.js';
import { sendTrialFollowUps } from '../../src/lib/jobs/parent.js';
import { allJobs } from '../../src/lib/cron.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const now = () => iso(Date.now());

// A confirmed trial booking in `sessionId` (inserted directly: the session is
// already in the past, so no checkout could book it now).
async function confirmedTrial(fam, sessionId, { id, attendance = null, childId = fam.childId } = {}) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, list_amount_cents, amount_cents,
                             paid_cents, payment_method, payment_status, created_at)
       VALUES (?1, ?2, ?3, 'trial', ?4, 'confirmed', 3000, 3000, 3000, 'full', 'paid', ?5)`,
    ).bind(id, fam.userId, childId, fam.termId, daysFromNow(-10)),
    env.DB.prepare(
      `INSERT INTO booking_sessions (booking_id, session_id, status, attendance) VALUES (?1, ?2, 'booked', ?3)`,
    ).bind(id, sessionId, attendance),
  ]);
}

// A confirmed term booking covering the given sessions.
async function confirmedTerm(fam, sessionIds, { id, childId }) {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, created_at)
       VALUES (?1, ?2, ?3, 'term', ?4, 'confirmed', 14000, ?5)`,
    ).bind(id, fam.userId, childId, fam.termId, now()),
    ...sessionIds.map((sessionId) => env.DB.prepare(
      `INSERT INTO booking_sessions (booking_id, session_id, status) VALUES (?1, ?2, 'booked')`,
    ).bind(id, sessionId)),
  ]);
}

const mailFor = async (email) => (await env.DB.prepare(
  `SELECT subject, body_text FROM dev_emails WHERE to_email = ?1 ORDER BY id`,
).bind(email).all()).results;

test('the job is registered after the core jobs', () => {
  const names = allJobs().map((j) => j.name);
  assert.ok(names.includes('trialFollowUps'));
  assert.ok(names.indexOf('trialFollowUps') > names.indexOf('sweepExpiredBookings'));
});

test('the day after a trial: one offer of the remaining weeks at the pro-rata price', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'tf-a', startInDays: -2 }); // week 1 was two days ago
  await confirmedTrial(fam, fam.sessionIds[0], { id: 'tf-a-trial' });

  const first = await sendTrialFollowUps(env, { now: now() });
  assert.equal(first.sent, 1);
  const mail = await mailFor('tf-a@example.com');
  assert.equal(mail.length, 1);
  assert.equal(mail[0].subject, "How was Child 0's trial class? Join the rest of Test Term");
  assert.match(mail[0].body_text, /the remaining 5 weeks of Test Term for \$140\.00/, 'round(16800 × 5 / 6)');
  assert.match(mail[0].body_text, /5 weekly instalments \(\$28\.00 when you book, then \$28\.00\)/);
  assert.match(mail[0].body_text, /\/book\/checkout\?kind=term&term=tf-a-term&child=tf-a-child-0/);
  const log = await env.DB.prepare(`SELECT template, booking_id, status FROM email_log WHERE dedupe_key = 'trial_followup:tf-a-trial'`).first();
  assert.deepEqual(log, { template: 'trial_followup', booking_id: 'tf-a-trial', status: 'sent' });

  const second = await sendTrialFollowUps(env, { now: now() });
  assert.equal(second.sent, 0);
  assert.equal((await mailFor('tf-a@example.com')).length, 1, 'never sent twice');
});

test('not before 20 hours have passed, and not for trials over a week old', async () => {
  const soon = await seedFamilyAndTerm(env, { prefix: 'tf-b', startInDays: -10 / 24 }); // ten hours ago
  await confirmedTrial(soon, soon.sessionIds[0], { id: 'tf-b-trial' });
  const old = await seedFamilyAndTerm(env, { prefix: 'tf-c', startInDays: -8, weeks: 8 });
  await confirmedTrial(old, old.sessionIds[0], { id: 'tf-c-trial' });
  await sendTrialFollowUps(env, { now: now() });
  assert.equal((await mailFor('tf-b@example.com')).length, 0);
  assert.equal((await mailFor('tf-c@example.com')).length, 0);

  // A day later the ten-hour-old trial is due.
  await sendTrialFollowUps(env, { now: daysFromNow(1) });
  assert.equal((await mailFor('tf-b@example.com')).length, 1);
});

test('nothing for an absent child, a cancelled trial, or a child already booked for the term', async () => {
  const absent = await seedFamilyAndTerm(env, { prefix: 'tf-d', startInDays: -2 });
  await confirmedTrial(absent, absent.sessionIds[0], { id: 'tf-d-trial', attendance: 'absent' });
  const cancelled = await seedFamilyAndTerm(env, { prefix: 'tf-e', startInDays: -2 });
  await confirmedTrial(cancelled, cancelled.sessionIds[0], { id: 'tf-e-trial' });
  await env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = 'tf-e-trial'`).run();
  const booked = await seedFamilyAndTerm(env, { prefix: 'tf-f', startInDays: -2 });
  await confirmedTrial(booked, booked.sessionIds[0], { id: 'tf-f-trial' });
  await confirmedTerm(booked, booked.sessionIds.slice(1), { id: 'tf-f-term', childId: booked.childId });

  const result = await sendTrialFollowUps(env, { now: now() });
  assert.equal(result.sent, 0);
  for (const email of ['tf-d@example.com', 'tf-e@example.com', 'tf-f@example.com']) {
    assert.equal((await mailFor(email)).length, 0, email);
  }
});

test('nothing once the term is closed', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'tf-h', startInDays: -2, status: 'closed' });
  await confirmedTrial(fam, fam.sessionIds[0], { id: 'tf-h-trial' });
  assert.equal((await sendTrialFollowUps(env, { now: now() })).sent, 0);
  assert.equal((await mailFor('tf-h@example.com')).length, 0);
});

test('a full term gets a waitlist invitation instead', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'tf-g', startInDays: -2, capacity: 1, children: 2 });
  await confirmedTrial(fam, fam.sessionIds[0], { id: 'tf-g-trial' });
  await confirmedTerm(fam, fam.sessionIds.slice(1), { id: 'tf-g-sibling', childId: fam.childIds[1] });
  const result = await sendTrialFollowUps(env, { now: now() });
  assert.equal(result.sent, 1);
  const [mail] = await mailFor('tf-g@example.com');
  assert.match(mail.body_text, /full at the moment, but you can join the waitlist/);
  assert.match(mail.body_text, /\/book\/waitlist\?term=tf-g-term/);
});
