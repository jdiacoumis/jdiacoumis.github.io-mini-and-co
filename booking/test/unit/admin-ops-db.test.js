// Admin operations against a real D1 (lib/admin-ops.js): creating terms with
// sessions, the term grid, transfers under the capacity and child rules,
// cancelling a week with a credit, cancelling a session (credits per family),
// restoring a cancelled booking only when seats are free, attendance,
// resolving flags, manual bookings and auto-enrol at the returning price.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, seedFamilyAndTerm, daysFromNow, iso } from './helpers.js';
import {
  prepareBooking, createPendingBooking, confirmBooking, cancelBooking,
} from '../../src/lib/domain.js';
import { availableCredits } from '../../src/lib/ledger.js';
import {
  createTermsWithSessions, syncTermDates, loadTermGrid, listTermsOverview, transferBookingSession,
  cancelBookingWeek, cancelSessionWithCredits, sessionCancellationPlan, restoreBooking, markAttendance,
  resolveAttention, createAdminBooking, autoEnrolCandidates, autoEnrolChild, listAttention, removeTermSession,
  bookingWeeks, cancelEndedBooking, findOrCreateParent, createChild, dashboardCounts,
} from '../../src/lib/admin-ops.js';
import { loadTerm } from '../../src/lib/domain.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const run = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).run();
const first = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).first();

// Book and pay (confirmed, with a checkout ledger row).
async function bookPaid(fam, { kind = 'term', sessionIds = [], childId = fam.childId, termId = fam.termId } = {}) {
  const prepared = await prepareBooking(env, { userId: fam.userId, childId, kind, termId, sessionIds });
  assert.equal(prepared.ok, true, `prepare failed: ${prepared.error}`);
  const created = await createPendingBooking(env, {
    userId: fam.userId, childId, kind, termId, sessionIds: prepared.quote.sessionIds, quote: prepared.quote,
    photoConsent: true, medicalNotes: '',
  });
  assert.ok(created.id, `create failed: ${created.error}`);
  if (prepared.quote.amountCents > 0) {
    const result = await confirmBooking(env, created.id, {
      provider: 'mock', payment: { kind: 'checkout', amountCents: prepared.quote.amountCents, provider: 'mock', providerRef: `pi_${created.id}` },
    });
    assert.equal(result.ok, true);
  } else {
    await confirmBooking(env, created.id, { provider: 'free' });
  }
  return created.id;
}

async function addFamily(prefix, { classId, termId }) {
  const userId = `${prefix}-user`;
  const childId = `${prefix}-child`;
  const now = iso(Date.now());
  await run(`INSERT INTO users (id, email, name, created_at) VALUES (?1, ?2, 'Parent', ?3)`, userId, `${prefix}@example.com`, now);
  await run(`INSERT INTO children (id, user_id, name, dob, photo_consent, created_at) VALUES (?1, ?2, ?3, '2025-10-01', 1, ?4)`,
    childId, userId, `Child ${prefix}`, now);
  return { userId, childId, childIds: [childId], classId, termId };
}

const rowStatus = async (bookingId, sessionId) => (await first(
  `SELECT status FROM booking_sessions WHERE booking_id = ?1 AND session_id = ?2`, bookingId, sessionId,
))?.status;

test('createTermsWithSessions inserts terms and sessions atomically; dates follow the sessions', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'ct' });
  const [termId] = await createTermsWithSessions(env, [{
    classId: fam.classId, name: 'Term 2 2027', startsOn: '2027-04-28', endsOn: '2027-05-12',
    termPriceCents: 9000, casualPriceCents: 3000, sessions: [
      { startsAt: '2027-04-28T01:00:00Z' }, { startsAt: '2027-05-05T01:00:00Z' }, { startsAt: '2027-05-12T01:00:00Z' },
    ], durationMins: 45, capacity: 10, status: 'draft',
  }]);
  const term = await loadTerm(env, termId);
  assert.equal(term.status, 'draft');
  const sessions = (await env.DB.prepare(`SELECT * FROM class_sessions WHERE term_id = ?1 ORDER BY starts_at`).bind(termId).all()).results;
  assert.equal(sessions.length, 3);
  assert.ok(sessions.every((s) => s.capacity === 10 && s.casual_price_cents === 3000));

  assert.equal(await removeTermSession(env, termId, sessions[2].id), true);
  await syncTermDates(env, termId);
  assert.equal((await loadTerm(env, termId)).ends_on, '2027-05-05');
  const overview = (await listTermsOverview(env)).find((t) => t.id === termId);
  assert.equal(overview.session_count, 2);
  assert.equal(overview.live_bookings, 0);
});

test('a week with bookings cannot be removed', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'rw' });
  await bookPaid(fam);
  assert.equal(await removeTermSession(env, fam.termId, fam.sessionIds[0]), false);
  assert.ok(await first(`SELECT id FROM class_sessions WHERE id = ?1`, fam.sessionIds[0]));
});

test('the grid: one row per live family, cells per week, payment from the ledger', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'gr' });
  const paid = await bookPaid(fam);
  const other = await addFamily('gr2', fam);
  await bookPaid({ ...fam, ...other }, { kind: 'casual', sessionIds: [fam.sessionIds[2]] });
  await markAttendance(env, { sessionId: fam.sessionIds[0], bookingId: paid, mark: 'present', by: 'admin' });

  const grid = await loadTermGrid(env, fam.termId);
  assert.equal(grid.sessions.length, 6);
  assert.equal(grid.grid.length, 2);
  const term = grid.grid.find((r) => r.booking.id === paid);
  assert.deepEqual(term.cells, ['present', 'booked', 'booked', 'booked', 'booked', 'booked']);
  assert.equal(term.payment.label, 'Paid');
  const casual = grid.grid.find((r) => r.booking.id !== paid);
  assert.deepEqual(casual.cells, ['none', 'none', 'booked', 'none', 'none', 'none']);
  assert.equal(grid.sessions[2].seats_left, 10);
});

test('transfer: the seat moves under the capacity and child rules, no money changes', async () => {
  const famA = await seedFamilyAndTerm(env, { prefix: 'tra', capacity: 2 });
  const famB = await seedFamilyAndTerm(env, { prefix: 'trb', capacity: 1 });
  const bookingA = await bookPaid(famA);

  const ok = await transferBookingSession(env, {
    bookingId: bookingA, fromSessionId: famA.sessionIds[1], toSessionId: famB.sessionIds[1], by: 'admin',
  });
  assert.deepEqual(ok, { ok: true });
  assert.equal(await rowStatus(bookingA, famA.sessionIds[1]), 'transferred_out');
  assert.equal(await rowStatus(bookingA, famB.sessionIds[1]), 'booked');
  const from = await first(`SELECT transferred_to_session_id FROM booking_sessions WHERE booking_id = ?1 AND session_id = ?2`,
    bookingA, famA.sessionIds[1]);
  assert.equal(from.transferred_to_session_id, famB.sessionIds[1]);
  assert.equal(await bookingWeeks(env, bookingA), 6, 'a transfer keeps the week count');
  const money = await first(`SELECT paid_cents, amount_cents FROM bookings WHERE id = ?1`, bookingA);
  assert.equal(money.paid_cents, money.amount_cents);

  // famB's capacity-1 week 2 is now full: B's own family can't get in.
  const bookingB = await bookPaid(famB, { kind: 'casual', sessionIds: [famB.sessionIds[0]] });
  const full = await transferBookingSession(env, {
    bookingId: bookingB, fromSessionId: famB.sessionIds[0], toSessionId: famB.sessionIds[1],
  });
  assert.deepEqual(full, { ok: false, error: 'target_full' });
  // A child already in the target session is refused.
  const dup = await transferBookingSession(env, {
    bookingId: bookingA, fromSessionId: famA.sessionIds[2], toSessionId: famB.sessionIds[1],
  });
  assert.equal(dup.error, 'already_in_target');
  // The moved-out week can't be moved again.
  const again = await transferBookingSession(env, {
    bookingId: bookingA, fromSessionId: famA.sessionIds[1], toSessionId: famB.sessionIds[2],
  });
  assert.equal(again.error, 'not_booked');
});

test('cancel one week with a credit for the per-week value', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'cw' });
  const bookingId = await bookPaid(fam);
  const result = await cancelBookingWeek(env, {
    bookingId, sessionId: fam.sessionIds[3], creditCents: 2800, reason: 'Unwell', by: 'admin-1',
  });
  assert.equal(result.ok, true);
  assert.equal(await rowStatus(bookingId, fam.sessionIds[3]), 'cancelled');
  const credit = await first(`SELECT * FROM credits WHERE id = ?1`, result.creditId);
  assert.equal(credit.amount_cents, 2800);
  assert.equal(credit.child_id, fam.childId);
  assert.equal(credit.source_booking_id, bookingId);
  assert.equal(credit.source_session_id, fam.sessionIds[3]);
  const credits = await availableCredits(env, fam.userId, fam.childId);
  assert.equal(credits.reduce((s, c) => s + c.remaining_cents, 0), 2800);
  // Twice is refused; the seat is free for others.
  assert.equal((await cancelBookingWeek(env, { bookingId, sessionId: fam.sessionIds[3] })).error, 'not_booked');
  const grid = await loadTermGrid(env, fam.termId);
  assert.equal(grid.grid[0].cells[3], 'cancelled');
});

test('cancelling a session: rows cancelled, credits for paid families, none for unpaid or comp', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'cs' });
  const termBooking = await bookPaid(fam);
  const casualFam = await addFamily('cs2', fam);
  const casualBooking = await bookPaid({ ...fam, ...casualFam }, { kind: 'casual', sessionIds: [fam.sessionIds[4]] });
  const compFam = await addFamily('cs3', fam);
  const comp = await createAdminBooking(env, {
    userId: compFam.userId, childId: compFam.childId, kind: 'term', termId: fam.termId, mode: 'comp', by: 'admin',
  });
  assert.equal(comp.ok, true);
  const laterFam = await addFamily('cs4', fam);
  const later = await createAdminBooking(env, {
    userId: laterFam.userId, childId: laterFam.childId, kind: 'term', termId: fam.termId, mode: 'paylater', by: 'admin',
  });
  assert.equal(later.ok, true);

  const plan = await sessionCancellationPlan(env, fam.sessionIds[4]);
  assert.equal(plan.length, 4);
  const result = await cancelSessionWithCredits(env, fam.sessionIds[4], { reason: 'Venue closed', by: 'admin-1' });
  assert.equal(result.ok, true);
  assert.equal(result.creditsIssued, 2);
  assert.equal(result.creditCents, 2800 + 3000);

  const session = await first(`SELECT status, cancelled_reason, cancelled_at FROM class_sessions WHERE id = ?1`, fam.sessionIds[4]);
  assert.equal(session.status, 'cancelled');
  assert.equal(session.cancelled_reason, 'Venue closed');
  assert.ok(session.cancelled_at);
  for (const id of [termBooking, casualBooking, comp.bookingId, later.bookingId]) {
    assert.equal(await rowStatus(id, fam.sessionIds[4]), 'cancelled');
  }
  const credits = (await env.DB.prepare(
    `SELECT source_booking_id, amount_cents, reason FROM credits WHERE source_session_id = ?1 ORDER BY amount_cents`,
  ).bind(fam.sessionIds[4]).all()).results;
  assert.deepEqual(credits.map((c) => [c.source_booking_id, c.amount_cents]), [[termBooking, 2800], [casualBooking, 3000]]);
  assert.match(credits[0].reason, /Class cancelled .*Venue closed/);
  // Bookings stay confirmed; a second cancel is refused.
  assert.equal((await first(`SELECT status FROM bookings WHERE id = ?1`, termBooking)).status, 'confirmed');
  assert.equal((await cancelSessionWithCredits(env, fam.sessionIds[4], { reason: 'again', by: 'x' })).error, 'not_scheduled');
});

test('restore: only while every week still has a seat', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'rs', capacity: 1 });
  const bookingId = await bookPaid(fam);
  assert.equal((await cancelBooking(env, bookingId, { by: 'admin' })).ok, true);

  // Someone else takes week 3 in the meantime.
  const other = await addFamily('rs2', fam);
  const otherBooking = await bookPaid({ ...fam, ...other }, { kind: 'casual', sessionIds: [fam.sessionIds[2]] });
  const refused = await restoreBooking(env, bookingId, { by: 'admin' });
  assert.equal(refused.error, 'no_seat');
  assert.deepEqual(refused.sessions.map((s) => s.id), [fam.sessionIds[2]]);
  assert.equal((await first(`SELECT status FROM bookings WHERE id = ?1`, bookingId)).status, 'cancelled');

  await cancelBooking(env, otherBooking, { by: 'admin' });
  assert.deepEqual(await restoreBooking(env, bookingId, { by: 'admin' }), { ok: true });
  const restored = await first(`SELECT status, cancelled_at, admin_notes FROM bookings WHERE id = ?1`, bookingId);
  assert.equal(restored.status, 'confirmed');
  assert.equal(restored.cancelled_at, null);
  assert.match(restored.admin_notes, /restored/);
  assert.equal((await restoreBooking(env, bookingId)).error, 'not_cancelled');
});

test('a never-paid pending booking that was cancelled cannot be restored', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'rn' });
  const later = await createAdminBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'term', termId: fam.termId, mode: 'paylater', by: 'admin',
  });
  await cancelBooking(env, later.bookingId, { by: 'admin' });
  assert.equal((await restoreBooking(env, later.bookingId)).error, 'never_confirmed');
});

test('attendance: booked rows of live bookings only, recording who and when', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'at' });
  const bookingId = await bookPaid(fam);
  assert.equal(await markAttendance(env, { sessionId: fam.sessionIds[0], bookingId, mark: 'absent', by: 'staff-1' }), true);
  const row = await first(`SELECT attendance, attendance_marked_by, attendance_marked_at FROM booking_sessions
                           WHERE booking_id = ?1 AND session_id = ?2`, bookingId, fam.sessionIds[0]);
  assert.equal(row.attendance, 'absent');
  assert.equal(row.attendance_marked_by, 'staff-1');
  assert.ok(row.attendance_marked_at);
  assert.equal(await markAttendance(env, { sessionId: fam.sessionIds[0], bookingId, mark: null, by: 'staff-1' }), true);
  assert.equal((await first(`SELECT attendance FROM booking_sessions WHERE booking_id = ?1 AND session_id = ?2`,
    bookingId, fam.sessionIds[0])).attendance, null);
  await cancelBookingWeek(env, { bookingId, sessionId: fam.sessionIds[1] });
  assert.equal(await markAttendance(env, { sessionId: fam.sessionIds[1], bookingId, mark: 'present', by: 'x' }), false);
  await assert.rejects(() => markAttendance(env, { sessionId: fam.sessionIds[0], bookingId, mark: 'late', by: 'x' }));
});

test('manual bookings: offline paid now, pay-later hold, complimentary', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'mb' });
  const now = iso(Date.now());
  const offline = await createAdminBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'casual', termId: fam.termId, sessionIds: [fam.sessionIds[0]],
    mode: 'offline', method: 'cash', note: 'At the door', nonce: 'nonce-1', by: 'admin-1', now,
  });
  assert.equal(offline.ok, true);
  assert.equal(offline.confirmed, true);
  const b = await first(`SELECT status, payment_status, payment_method, payment_provider, paid_cents FROM bookings WHERE id = ?1`, offline.bookingId);
  assert.deepEqual(b, { status: 'confirmed', payment_status: 'paid', payment_method: 'offline', payment_provider: 'external', paid_cents: 3000 });
  const ledger = await first(`SELECT kind, method, note, recorded_by, provider_ref FROM payments WHERE booking_id = ?1`, offline.bookingId);
  assert.deepEqual(ledger, { kind: 'offline', method: 'cash', note: 'At the door', recorded_by: 'admin-1', provider_ref: 'offline:nonce-1' });

  const later = await createAdminBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'casual', termId: fam.termId, sessionIds: [fam.sessionIds[1]],
    priceOverrideCents: 2500, mode: 'paylater', by: 'admin-1', now,
  });
  const p = await first(`SELECT status, amount_cents, expires_at, payment_method FROM bookings WHERE id = ?1`, later.bookingId);
  assert.equal(p.status, 'pending');
  assert.equal(p.amount_cents, 2500);
  assert.equal(p.payment_method, 'full');
  const holdDays = (Date.parse(p.expires_at) - Date.parse(now)) / 86400e3;
  assert.equal(Math.round(holdDays), 7);

  const otherChild = await createChild(env, { userId: fam.userId, name: 'Sibling', dob: '2025-12-01', photoConsent: false });
  const comp = await createAdminBooking(env, {
    userId: fam.userId, childId: otherChild, kind: 'term', termId: fam.termId, mode: 'comp', by: 'admin-1', now,
  });
  const c = await first(`SELECT kind, status, payment_status, amount_cents, payment_method, photo_consent_snapshot FROM bookings WHERE id = ?1`, comp.bookingId);
  assert.deepEqual(c, { kind: 'complimentary', status: 'confirmed', payment_status: 'waived', amount_cents: 0, payment_method: 'none', photo_consent_snapshot: 0 });

  const full = await createAdminBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'casual', termId: fam.termId, sessionIds: [fam.sessionIds[0]],
    mode: 'offline', by: 'admin-1', now,
  });
  assert.equal(full.error, 'already_booked');
});

test('find or create a parent reuses the account and only fills blanks', async () => {
  const first1 = await findOrCreateParent(env, { email: 'phone-parent@example.com', name: 'Ana', phone: '0400000001' });
  assert.equal(first1.created, true);
  const again = await findOrCreateParent(env, { email: 'phone-parent@example.com', name: 'Someone Else', phone: '0499' });
  assert.equal(again.created, false);
  assert.equal(again.id, first1.id);
  const user = await first(`SELECT name, phone FROM users WHERE id = ?1`, first1.id);
  assert.deepEqual(user, { name: 'Ana', phone: '0400000001' });
});

test('auto-enrol: term families from the previous term get held places at the returning price', async () => {
  const prev = await seedFamilyAndTerm(env, { prefix: 'ae', startInDays: -50, status: 'closed' });
  // The previous term ran in the past: a confirmed (imported-style) term booking.
  await run(
    `INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, payment_method, payment_status, created_at)
     VALUES ('ae-prev-booking', ?1, ?2, 'term', ?3, 'confirmed', 0, 'none', 'paid', ?4)`,
    prev.userId, prev.childId, prev.termId, iso(Date.now()),
  );
  const casualFam = await addFamily('ae2', prev);
  await run(
    `INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, payment_method, payment_status, created_at)
     VALUES ('ae-prev-casual', ?1, ?2, 'casual', ?3, 'confirmed', 3000, 'full', 'paid', ?4)`,
    casualFam.userId, casualFam.childId, prev.termId, iso(Date.now()),
  );
  const publicOpensAt = daysFromNow(10);
  const [termId] = await createTermsWithSessions(env, [{
    classId: prev.classId, name: 'Next Term', startsOn: '2099-01-07', endsOn: '2099-01-21',
    termPriceCents: 16800, casualPriceCents: 3000, returningPriceCents: 15000, publicOpensAt, previousTermId: prev.termId,
    sessions: [{ startsAt: daysFromNow(20) }, { startsAt: daysFromNow(27) }, { startsAt: daysFromNow(34) }],
    durationMins: 45, capacity: 12, status: 'draft',
  }]);
  const term = await loadTerm(env, termId);
  const candidates = await autoEnrolCandidates(env, term);
  assert.equal(candidates.length, 2);
  const termFamily = candidates.find((c) => c.childId === prev.childId);
  assert.equal(termFamily.termFamily, true);
  assert.equal(candidates.find((c) => c.childId === casualFam.childId).termFamily, false);

  const result = await autoEnrolChild(env, { term, userId: prev.userId, childId: prev.childId });
  assert.equal(result.ok, true);
  assert.equal(result.amountCents, 15000);
  assert.equal(result.expiresAt, publicOpensAt);
  const b = await first(`SELECT status, kind, list_amount_cents, expires_at, payment_method FROM bookings WHERE id = ?1`, result.bookingId);
  assert.deepEqual(b, { status: 'pending', kind: 'term', list_amount_cents: 15000, expires_at: publicOpensAt, payment_method: 'full' });
  assert.equal((await autoEnrolCandidates(env, term)).find((c) => c.childId === prev.childId).alreadyHeld, true);
  const again = await autoEnrolChild(env, { term, userId: prev.userId, childId: prev.childId });
  assert.equal(again.ok, false);
});

test('needs attention: flagged, stale checkouts, and resolving with a note', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'na' });
  const bookingId = await bookPaid(fam, { kind: 'casual', sessionIds: [fam.sessionIds[0]] });
  await run(`UPDATE bookings SET needs_attention = 'webhook_mismatch' WHERE id = ?1`, bookingId);
  const prepared = await prepareBooking(env, { userId: fam.userId, childId: fam.childId, kind: 'casual', termId: fam.termId, sessionIds: [fam.sessionIds[1]] });
  const stale = await createPendingBooking(env, {
    userId: fam.userId, childId: fam.childId, kind: 'casual', termId: fam.termId, sessionIds: prepared.quote.sessionIds,
    quote: prepared.quote,
  });
  await run(`UPDATE bookings SET payment_ref = 'cs_test_stale', created_at = ?2 WHERE id = ?1`, stale.id, daysFromNow(-1 / 24));

  const list = await listAttention(env);
  assert.ok(list.flagged.some((b) => b.id === bookingId));
  assert.ok(list.stale.some((b) => b.id === stale.id));
  const counts = await dashboardCounts(env);
  assert.ok(counts.attention >= 2);

  assert.equal(await resolveAttention(env, bookingId, { note: 'Refunded the difference', by: 'admin-1' }), true);
  const b = await first(`SELECT needs_attention, admin_notes FROM bookings WHERE id = ?1`, bookingId);
  assert.equal(b.needs_attention, null);
  assert.match(b.admin_notes, /resolved "Payment doesn't match the booking" — Refunded the difference/);
  assert.equal(await resolveAttention(env, bookingId, { note: 'again' }), false);
});

test('an expired "paid, no seat" booking can be marked cancelled', async () => {
  const fam = await seedFamilyAndTerm(env, { prefix: 'pe' });
  await run(
    `INSERT INTO bookings (id, user_id, child_id, kind, term_id, status, amount_cents, needs_attention, created_at)
     VALUES ('pe-booking', ?1, ?2, 'casual', ?3, 'expired', 3000, 'paid_no_seat', ?4)`,
    fam.userId, fam.childId, fam.termId, iso(Date.now()),
  );
  assert.equal(await cancelEndedBooking(env, 'pe-booking', { by: 'admin-1', reason: 'Refunded' }), true);
  const b = await first(`SELECT status, cancelled_by, cancel_reason FROM bookings WHERE id = 'pe-booking'`);
  assert.deepEqual(b, { status: 'cancelled', cancelled_by: 'admin-1', cancel_reason: 'Refunded' });
  assert.equal(await cancelEndedBooking(env, 'pe-booking', { by: 'admin-1' }), false);
});
