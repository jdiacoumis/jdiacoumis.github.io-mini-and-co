// Ops scheduled jobs (lib/jobs/ops.js): day-before reminders, overdue-plan
// nudges and waitlist reconciliation — each idempotent at a 15-minute cadence.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm, iso } from './helpers.js';
import {
  sendReminders, overdueNudges, reconcileWaitlist, reminderWindow, isoWeekKey, planShortfallCents, jobs,
} from '../../src/lib/jobs/ops.js';
import { allJobs } from '../../src/lib/cron.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const NOW = '2027-03-01T00:00:00Z'; // Mon 1 Mar 2027, 11:00 am AEDT
const at = (hours, from = NOW) => iso(Date.parse(from) + hours * 3600 * 1000);
const run = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).run();
const one = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).first();
const count = async (sql, ...binds) => (await one(sql, ...binds)).n;

async function family(prefix, name = `${prefix} child`) {
  await run(`INSERT INTO users (id, email, name, created_at) VALUES (?1, ?2, ?3, ?4)`, `${prefix}-u`, `${prefix}@example.com`, `${prefix} parent`, NOW);
  await run(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES (?1, ?2, ?3, '2026-06-01', ?4)`, `${prefix}-c`, `${prefix}-u`, name, NOW);
  return { userId: `${prefix}-u`, childId: `${prefix}-c` };
}

async function booking(id, f, { status = 'confirmed', rows = [], kind = 'casual', expiresAt = null, extra = {} }) {
  await run(
    `INSERT INTO bookings (id, user_id, child_id, kind, status, list_amount_cents, amount_cents, payment_method,
                           payment_status, plan_instalments, plan_instalment_cents, plan_interval, paid_at,
                           needs_attention, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    id, f.userId, f.childId, kind, status, extra.amount ?? 3000, extra.method ?? 'full', extra.paymentStatus ?? 'paid',
    extra.instalments ?? null, extra.each ?? null, extra.interval ?? null, extra.paidAt ?? null,
    extra.attention ?? null, at(-24 * 30), expiresAt,
  );
  for (const [sessionId, rowStatus = 'booked'] of rows) {
    await run(`INSERT INTO booking_sessions (booking_id, session_id, status) VALUES (?1, ?2, ?3)`, id, sessionId, rowStatus);
  }
}

test('the ops jobs are registered after the core jobs', () => {
  assert.deepEqual(jobs.map((j) => j.name), ['sendReminders', 'overdueNudges', 'reconcileWaitlist']);
  const names = allJobs().map((j) => j.name);
  for (const name of ['sendReminders', 'overdueNudges', 'reconcileWaitlist']) {
    assert.ok(names.indexOf(name) > names.indexOf('expireOffers'), name);
  }
});

test('reminder window is 20–28 hours ahead', () => {
  assert.deepEqual(reminderWindow(NOW), { from: '2027-03-01T20:00:00Z', to: '2027-03-02T04:00:00Z' });
});

test('ISO week keys follow the Sydney calendar', () => {
  assert.equal(isoWeekKey('2026-10-13T00:00:00Z'), '2026-W42');
  assert.equal(isoWeekKey('2026-12-31T12:00:00Z'), '2026-W53', 'Fri 1 Jan 2027 in Sydney is still 2026-W53');
  assert.equal(isoWeekKey('2027-01-03T12:59:00Z'), '2026-W53', 'Sun 3 Jan, 11:59 pm Sydney');
  assert.equal(isoWeekKey('2027-01-03T13:00:00Z'), '2027-W01', 'Mon 4 Jan, midnight Sydney');
});

test('reminders: one per (session, booking) for confirmed booked seats in sessions 20–28 h ahead', async () => {
  await run(`INSERT INTO classes (id, name, venue, created_at) VALUES ('rm-class', 'Sensory Play — Tuesday', 'Oran Park Library', ?1)`, NOW);
  const sessions = { 'rm-19': at(19), 'rm-21': at(21), 'rm-27': at(27), 'rm-29': at(29), 'rm-22c': at(22) };
  for (const [id, startsAt] of Object.entries(sessions)) {
    await run(
      `INSERT INTO class_sessions (id, class_id, starts_at, capacity, casual_price_cents, status, created_at)
       VALUES (?1, 'rm-class', ?2, 10, 3000, ?3, ?4)`,
      id, startsAt, id === 'rm-22c' ? 'cancelled' : 'scheduled', NOW,
    );
  }
  const f1 = await family('rm-1', 'Edie');
  const f2 = await family('rm-2');
  const f3 = await family('rm-3');
  const f4 = await family('rm-4');
  await booking('rm-b1', f1, { rows: Object.keys(sessions).map((s) => [s]) });
  await booking('rm-b2', f2, { status: 'pending', expiresAt: at(30), rows: [['rm-21']] });
  await booking('rm-b3', f3, { rows: [['rm-21', 'cancelled'], ['rm-27', 'transferred_out']] });
  await booking('rm-b4', f4, { status: 'cancelled', rows: [['rm-21']] });

  assert.deepEqual(await sendReminders(env, { now: NOW }), { sent: 2, skipped: 0, failed: 0 });
  const keys = (await env.DB.prepare(`SELECT dedupe_key FROM email_log WHERE template = 'reminder' ORDER BY dedupe_key`).all())
    .results.map((r) => r.dedupe_key);
  assert.deepEqual(keys, ['reminder:rm-21:rm-b1', 'reminder:rm-27:rm-b1']);
  const mail = (await env.DB.prepare(`SELECT subject, body_text FROM dev_emails WHERE to_email = 'rm-1@example.com'`).all()).results;
  assert.equal(mail.length, 2);
  assert.ok(mail.every((m) => m.subject.startsWith("Reminder: Edie's class on") && m.body_text.includes('Oran Park Library')));
  for (const f of ['rm-2', 'rm-3', 'rm-4']) {
    assert.equal(await count(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = ?1`, `${f}@example.com`), 0, f);
  }

  // The next run (15 minutes later) sends nothing new.
  assert.deepEqual(await sendReminders(env, { now: at(0.25) }), { sent: 0, skipped: 0, failed: 0 });
  assert.equal(await count(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = 'rm-1@example.com'`), 2);

  // A failed send is retried by the next run, then never repeated.
  const f5 = await family('rm-5');
  await booking('rm-b5', f5, { rows: [['rm-21']] });
  assert.deepEqual(await sendReminders({ ...env, EMAIL_DRIVER: 'broken' }, { now: NOW }), { sent: 0, skipped: 0, failed: 1 });
  assert.equal((await one(`SELECT status FROM email_log WHERE dedupe_key = 'reminder:rm-21:rm-b5'`)).status, 'failed');
  assert.deepEqual(await sendReminders(env, { now: NOW }), { sent: 1, skipped: 0, failed: 0 });
  assert.deepEqual(await sendReminders(env, { now: NOW }), { sent: 0, skipped: 0, failed: 0 });
});

test('overdue plans are nudged at most every 7 days, with the amount behind schedule', async () => {
  const plan = (paidAt, attention = null) => ({
    method: 'plan', paymentStatus: 'plan_overdue', amount: 16800, instalments: 6, each: 2800, interval: 'week', paidAt, attention,
  });
  const g = await family('od-g', 'Ava');
  const h = await family('od-h');
  const i = await family('od-i');
  await booking('od-plan', g, { kind: 'term', extra: plan(at(-24 * 15)) });
  await booking('od-short', h, { kind: 'term', extra: plan(at(-24 * 15), 'plan_ended_short') });
  await booking('od-caught-up', i, { kind: 'term', extra: plan(at(-24 * 15)) });
  for (const [id, bookingId, amount] of [['in_a', 'od-plan', 2800], ['in_b', 'od-plan', 2800], ['in_c', 'od-caught-up', 16800]]) {
    await run(`INSERT INTO payments (id, booking_id, kind, amount_cents, provider_ref, paid_at, created_at)
               VALUES (?1, ?2, 'instalment', ?3, ?1, ?4, ?4)`, `p-${id}`, bookingId, amount, at(-24 * 10));
  }
  assert.equal(await planShortfallCents(env, await one(`SELECT * FROM bookings WHERE id = 'od-plan'`), NOW), 2800,
    'three instalments due by day 15, two paid');
  // The failure notice went out three days ago.
  await run(`INSERT INTO email_log (id, template, dedupe_key, to_email, booking_id, subject, status, sent_at)
             VALUES ('od-log', 'plan_failed', 'plan_failed:od-plan:in_x', 'od-g@example.com', 'od-plan', 's', 'sent', ?1)`, at(-72));

  assert.deepEqual(await overdueNudges(env, { now: NOW }), { sent: 0, skipped: 0, failed: 0, caughtUp: 1 },
    'too soon after the failure notice; the caught-up plan is left alone');

  await run(`UPDATE email_log SET sent_at = ?1 WHERE id = 'od-log'`, at(-24 * 8));
  assert.deepEqual(await overdueNudges(env, { now: NOW }), { sent: 1, skipped: 0, failed: 0, caughtUp: 1 });
  const nudge = await one(`SELECT template, dedupe_key FROM email_log WHERE booking_id = 'od-plan' AND template = 'plan_overdue'`);
  assert.deepEqual(nudge, { template: 'plan_overdue', dedupe_key: `plan_overdue:od-plan:${isoWeekKey(NOW)}` });
  const mail = await one(`SELECT subject, body_text FROM dev_emails WHERE to_email = 'od-g@example.com'`);
  assert.equal(mail.subject, "Reminder: a payment for Ava's classes is still outstanding");
  assert.ok(mail.body_text.includes('($28.00) is still outstanding'));
  assert.equal(await count(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = 'od-h@example.com'`), 0, 'plan ended short: owner handles it');

  // sendTemplate stamps real time; put the nudge on the simulated clock.
  const stamp = (when) => run(`UPDATE email_log SET sent_at = ?1 WHERE booking_id = 'od-plan' AND template = 'plan_overdue'`, when);
  await stamp(NOW);
  // The next run, 15 minutes later: nothing new.
  assert.equal((await overdueNudges(env, { now: at(0.25) })).sent, 0);
  // Sent on a Sunday: the Monday after is a new ISO week but not 7 days on.
  await stamp(at(24 * 6));
  assert.equal(isoWeekKey(at(24 * 7)) === isoWeekKey(at(24 * 6)), false);
  assert.equal((await overdueNudges(env, { now: at(24 * 7) })).sent, 0);
  // A week after that it goes again, with the larger shortfall.
  assert.equal((await overdueNudges(env, { now: at(24 * 13 + 1) })).sent, 1);
  const latest = await one(`SELECT body_text FROM dev_emails WHERE to_email = 'od-g@example.com' ORDER BY id DESC LIMIT 1`);
  assert.ok(latest.body_text.includes('($84.00)'), latest.body_text);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = 'od-g@example.com'`), 2);
  assert.equal(await count(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = 'od-i@example.com'`), 0, 'caught up: never nudged');
});

test('waitlist entries whose offer was paid become booked', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'rw', children: 4 });
  const states = [['rw-offered-paid', 'offered', 'confirmed'], ['rw-offered-pending', 'offered', 'pending'],
    ['rw-waiting-paid', 'waiting', 'confirmed'], ['rw-declined-paid', 'declined', 'confirmed']];
  for (const [index, [id, entryStatus, bookingStatus]] of states.entries()) {
    const childId = fam.childIds[index];
    await run(`INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, created_at, expires_at)
               VALUES (?1, ?2, ?3, 'term', ?4, ?5, 16800, ?6, ?7)`, `${id}-b`, fam.userId, childId, fam.termId, bookingStatus, NOW, at(48));
    await run(`INSERT INTO waitlist (id, term_id, user_id, child_id, status, joined_at, offer_booking_id)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`, id, fam.termId, fam.userId, childId, entryStatus, NOW, `${id}-b`);
  }
  assert.deepEqual(await reconcileWaitlist(env, { now: NOW }), { booked: 2 });
  const statuses = Object.fromEntries((await env.DB.prepare(`SELECT id, status FROM waitlist WHERE term_id = ?1`).bind(fam.termId).all())
    .results.map((r) => [r.id, r.status]));
  assert.deepEqual(statuses, {
    'rw-offered-paid': 'booked', 'rw-offered-pending': 'offered', 'rw-waiting-paid': 'booked', 'rw-declined-paid': 'declined',
  });
  assert.deepEqual(await reconcileWaitlist(env, { now: NOW }), { booked: 0 }, 'idempotent');
});
