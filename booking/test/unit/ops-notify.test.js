// Family notices (lib/notify.js): a cancelled session emails exactly the
// families it affected, with their credit, plus an owner summary; a failed
// instalment emails the family once per invoice and the owner per attempt.
// Both are idempotent (email_log dedupe keys).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm, daysFromNow, iso } from './helpers.js';
import { notifySessionCancelled, notifyPlanFailed, sessionCancelledRecipients } from '../../src/lib/notify.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const run = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).run();
const all = async (sql, ...binds) => (await env.DB.prepare(sql).bind(...binds).all()).results;
const one = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).first();

async function family(prefix, childName = `${prefix} child`) {
  const now = iso(Date.now());
  await run(`INSERT INTO users (id, email, name, created_at) VALUES (?1, ?2, ?3, ?4)`,
    `${prefix}-u`, `${prefix}@example.com`, `${prefix} parent`, now);
  await run(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES (?1, ?2, ?3, '2025-09-01', ?4)`,
    `${prefix}-c`, `${prefix}-u`, childName, now);
  return { userId: `${prefix}-u`, childId: `${prefix}-c`, email: `${prefix}@example.com` };
}

async function booking({ id, userId, childId, termId, kind = 'casual', status = 'confirmed', sessions,
  expiresAt = null, cancelledAt = null, paymentMethod = 'full', paymentStatus = 'paid', amount = 3000 }) {
  await run(
    `INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, list_amount_cents, amount_cents,
                           payment_method, payment_status, created_at, expires_at, cancelled_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10, ?11, ?12)`,
    id, userId, childId, kind, termId, status, amount, paymentMethod, paymentStatus, daysFromNow(-10), expiresAt, cancelledAt,
  );
  for (const [sessionId, rowStatus = 'booked', changedAt = null] of sessions) {
    await run(`INSERT INTO booking_sessions (booking_id, session_id, status, changed_at) VALUES (?1, ?2, ?3, ?4)`,
      id, sessionId, rowStatus, changedAt);
  }
}

async function credit({ id, userId, childId = null, amount, sessionId, bookingId = null, issuedAt }) {
  await run(
    `INSERT INTO credits (id, user_id, child_id, amount_cents, remaining_cents, reason, source_booking_id,
                          source_session_id, issued_by, issued_at)
     VALUES (?1, ?2, ?3, ?4, ?4, 'Class cancelled', ?5, ?6, 'system', ?7)`,
    id, userId, childId, amount, bookingId, sessionId, issuedAt,
  );
}

test('a cancelled session emails each affected family once, with their credit, and the owner a summary', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'sc', children: 2 });
  const target = fam.sessionIds[2];
  const cancelAt = iso(Date.now());
  const longAgo = daysFromNow(-3);
  const other = await family('sc-other');
  const pending = await family('sc-lapsed');
  const moved = await family('sc-moved');
  const early = await family('sc-early');
  const casual = await family('sc-casual', '<b>Kit</b>');
  const old = await family('sc-old');

  // Term family: its row for the session is cancelled with the session, credit for the week.
  await booking({
    id: 'sc-term', userId: fam.userId, childId: fam.childIds[0], termId: fam.termId, kind: 'term', amount: 16800,
    sessions: fam.sessionIds.map((s) => (s === target ? [s, 'cancelled', cancelAt] : [s])),
  });
  await credit({ id: 'sc-cr-term', userId: fam.userId, childId: fam.childIds[0], amount: 2800, sessionId: target, bookingId: 'sc-term', issuedAt: cancelAt });
  // Same parent, second child: a casual seat still 'booked', credit for that child.
  await booking({ id: 'sc-casual-1', userId: fam.userId, childId: fam.childIds[1], termId: fam.termId, sessions: [[target]] });
  await credit({ id: 'sc-cr-casual', userId: fam.userId, childId: fam.childIds[1], amount: 3000, sessionId: target, issuedAt: cancelAt });
  // A casual booking cancelled outright as part of the cancellation (credit against the booking).
  await booking({ id: 'sc-cancelled-now', userId: casual.userId, childId: casual.childId, termId: fam.termId, status: 'cancelled', cancelledAt: cancelAt, sessions: [[target]] });
  await credit({ id: 'sc-cr-booking', userId: casual.userId, amount: 3000, sessionId: target, bookingId: 'sc-cancelled-now', issuedAt: cancelAt });
  // A confirmed family with no credit (owner chose none).
  await booking({ id: 'sc-nocredit', userId: other.userId, childId: other.childId, termId: fam.termId, sessions: [[target]] });
  // Left out: a lapsed hold, a transfer out, a week cancelled days earlier, a booking cancelled long ago.
  await booking({ id: 'sc-lapsed', userId: pending.userId, childId: pending.childId, termId: fam.termId, status: 'pending', expiresAt: daysFromNow(-1), paymentStatus: 'unpaid', sessions: [[target]] });
  await booking({ id: 'sc-moved', userId: moved.userId, childId: moved.childId, termId: fam.termId, sessions: [[target, 'transferred_out', longAgo]] });
  await booking({ id: 'sc-early', userId: early.userId, childId: early.childId, termId: fam.termId, sessions: [[target, 'cancelled', longAgo]] });
  await credit({ id: 'sc-cr-early', userId: early.userId, childId: early.childId, amount: 3000, sessionId: target, issuedAt: longAgo });
  await booking({ id: 'sc-old', userId: old.userId, childId: old.childId, termId: fam.termId, status: 'cancelled', cancelledAt: longAgo, sessions: [[target]] });

  // Still scheduled: nobody is told it is cancelled.
  const early1 = await notifySessionCancelled(env, target, { reason: 'venue closed' });
  assert.equal(early1.error, 'not_cancelled');
  assert.equal((await one(`SELECT COUNT(*) AS n FROM email_log WHERE session_id = ?1`, target)).n, 0);

  await run(`UPDATE class_sessions SET status = 'cancelled', cancelled_at = ?2, cancelled_reason = 'venue closed' WHERE id = ?1`,
    target, cancelAt);
  const session = await one(`SELECT * FROM class_sessions WHERE id = ?1`, target);
  const recipients = await sessionCancelledRecipients(env, session);
  assert.deepEqual(recipients.map((r) => r.booking_id).sort(),
    ['sc-cancelled-now', 'sc-casual-1', 'sc-nocredit', 'sc-term'].sort());

  const result = await notifySessionCancelled(env, target, { reason: 'venue closed' });
  assert.deepEqual(result, { families: 4, sent: 4, skipped: 0, failed: 0, creditCents: 8800 });

  const log = await all(`SELECT dedupe_key, booking_id, to_email, template FROM email_log WHERE session_id = ?1 AND template = 'session_cancelled'`, target);
  assert.deepEqual(log.map((r) => r.dedupe_key).sort(),
    ['sc-cancelled-now', 'sc-casual-1', 'sc-nocredit', 'sc-term'].map((b) => `session_cancelled:${target}:${b}`).sort());

  const mail = await all(`SELECT subject, body_text, body_html FROM dev_emails WHERE to_email = 'sc@example.com' ORDER BY id`);
  assert.equal(mail.length, 2, 'one email per booking (two children)');
  assert.ok(mail.some((m) => m.body_text.includes('credit of $28.00') && m.body_text.includes('Child 0')));
  assert.ok(mail.some((m) => m.body_text.includes('credit of $30.00') && m.body_text.includes('Child 1')));
  assert.ok(mail.every((m) => m.subject.startsWith('Class cancelled: Sensory Play,') && m.body_text.includes('(venue closed)')));
  const kit = await one(`SELECT body_text, body_html FROM dev_emails WHERE to_email = 'sc-casual@example.com'`);
  assert.ok(kit.body_text.includes('credit of $30.00 to your account for <b>Kit</b>'));
  assert.ok(kit.body_html.includes('&lt;b&gt;Kit&lt;/b&gt;') && !kit.body_html.includes('<b>Kit</b>'));
  const none = await one(`SELECT body_text FROM dev_emails WHERE to_email = 'sc-other@example.com'`);
  assert.ok(!none.body_text.includes('credit of'));
  for (const left of ['sc-lapsed', 'sc-moved', 'sc-early', 'sc-old']) {
    assert.equal((await one(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = ?1`, `${left}@example.com`)).n, 0, left);
  }

  const owner = await all(`SELECT subject, body_text FROM dev_emails WHERE to_email = 'owner@example.com' AND subject LIKE '%Class cancelled%'`);
  assert.equal(owner.length, 1);
  assert.match(owner[0].body_text, /Families emailed: 4 of 4\./);
  assert.match(owner[0].body_text, /Credits given: \$88\.00 in total/);
  assert.ok(owner[0].body_text.includes(`/admin/sessions/${target}/roster`));

  // Again (a retry, or a double submit): nobody is emailed twice.
  const again = await notifySessionCancelled(env, target, { reason: 'venue closed' });
  assert.deepEqual(again, { families: 4, sent: 0, skipped: 4, failed: 0, creditCents: 8800 });
  assert.equal((await one(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = 'sc@example.com'`)).n, 2);
  assert.equal((await one(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = 'owner@example.com' AND subject LIKE '%Class cancelled%'`)).n, 1);
});

test('notifySessionCancelled: unknown session, and a cancelled session nobody booked', async () => {
  assert.equal((await notifySessionCancelled(env, 'no-such-session')).error, 'not_found');
  const fam = await seedFamilyAndTerm(env, { prefix: 'sc2' });
  await run(`UPDATE class_sessions SET status = 'cancelled', cancelled_at = ?2 WHERE id = ?1`, fam.sessionIds[0], iso(Date.now()));
  const result = await notifySessionCancelled(env, fam.sessionIds[0]);
  assert.deepEqual(result, { families: 0, sent: 0, skipped: 0, failed: 0, creditCents: 0 });
  const owner = await one(`SELECT template, status FROM email_log WHERE dedupe_key = ?1`,
    `session_cancelled:${fam.sessionIds[0]}:owner@example.com`);
  assert.deepEqual(owner, { template: 'owner_session_cancelled', status: 'sent' }, 'the owner still gets the summary');
});

test('a failed instalment emails the family once per invoice and the owner per attempt', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'pf' });
  await run(`UPDATE users SET name = 'Priya' WHERE id = ?1`, fam.userId);
  await booking({
    id: 'pf-plan', userId: fam.userId, childId: fam.childId, termId: fam.termId, kind: 'term', amount: 16800,
    paymentMethod: 'plan', paymentStatus: 'plan_overdue', sessions: fam.sessionIds.map((s) => [s]),
  });

  const first = await notifyPlanFailed(env, 'pf-plan', { invoiceId: 'in_1', attempt: 1, amountDueCents: 2800 });
  assert.equal(first.parent.sent, true);
  assert.equal(first.owner.length, 1);
  const parentMail = await one(`SELECT subject, body_text FROM dev_emails WHERE to_email = 'pf@example.com'`);
  assert.equal(parentMail.subject, "Payment didn't go through — Child 0's classes");
  assert.ok(parentMail.body_text.startsWith('Hi Priya,'));
  assert.ok(parentMail.body_text.includes('($28.00)'));
  assert.ok(parentMail.body_text.includes('http://localhost:8787/account'));
  const logged = await one(`SELECT template, booking_id, term_id FROM email_log WHERE dedupe_key = 'plan_failed:pf-plan:in_1'`);
  assert.deepEqual(logged, { template: 'plan_failed', booking_id: 'pf-plan', term_id: fam.termId });
  const ownerMail = await one(`SELECT body_text FROM dev_emails WHERE to_email = 'owner@example.com' AND subject LIKE '%Instalment failed%'`);
  assert.ok(ownerMail.body_text.includes("We've emailed the family a link to update their card."));

  // Stripe's retry of the same invoice: no second family email, a second owner alert.
  const retry = await notifyPlanFailed(env, 'pf-plan', { invoiceId: 'in_1', attempt: 2, amountDueCents: 2800 });
  assert.deepEqual(retry.parent, { skipped: true });
  assert.equal(retry.owner[0].sent, true);
  assert.equal((await one(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = 'pf@example.com'`)).n, 1);
  assert.equal((await one(`SELECT COUNT(*) AS n FROM dev_emails WHERE to_email = 'owner@example.com' AND subject LIKE '%Instalment failed — Child 0%'`)).n, 2);

  // A webhook replay of the same attempt changes nothing.
  const replay = await notifyPlanFailed(env, 'pf-plan', { invoiceId: 'in_1', attempt: 2, amountDueCents: 2800 });
  assert.deepEqual(replay.parent, { skipped: true });
  assert.deepEqual(replay.owner, [{ skipped: true }]);

  // The next instalment's invoice failing is a new notice.
  assert.equal((await notifyPlanFailed(env, 'pf-plan', { invoiceId: 'in_2', attempt: 1 })).parent.sent, true);
  // No invoice id: keyed on the attempt.
  await notifyPlanFailed(env, 'pf-plan', { attempt: 3 });
  assert.ok(await one(`SELECT 1 AS x FROM email_log WHERE dedupe_key = 'plan_failed:pf-plan:attempt-3'`));
  assert.deepEqual(await notifyPlanFailed(env, 'missing-booking', { invoiceId: 'in_9' }), { parent: null, owner: [] });
});
