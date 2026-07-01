// Capacity-guarded booking creation against a real D1 database: the guarded
// batch must never oversell a session, must roll back atomically when any
// selected session is full, and must release seats when holds lapse.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from './helpers.js';
import { createPendingBooking, expireBooking, loadSessionsForBooking, sessionsAlreadyBookedForChild } from '../../src/lib/domain.js';

const { env, dispose } = await createTestDb();
after(() => dispose());

const NOW = new Date();
const FUTURE = new Date(NOW.getTime() + 7 * 86400e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
const PAST = new Date(NOW.getTime() - 86400e3).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function seed() {
  const run = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).run();
  await run(`INSERT INTO users (id, email, created_at) VALUES ('u1', 'p1@example.com', ?1), ('u2', 'p2@example.com', ?1)`, PAST);
  await run(`INSERT INTO children (id, user_id, name, dob, created_at) VALUES ('c1', 'u1', 'Ava', '2025-10-01', ?1), ('c2', 'u2', 'Billy', '2025-09-01', ?1)`, PAST);
  await run(`INSERT INTO classes (id, name, active, created_at) VALUES ('cls', 'Test Class', 1, ?1)`, PAST);
  await run(`INSERT INTO class_sessions (id, class_id, starts_at, duration_mins, capacity, price_cents, status, created_at)
             VALUES ('s-two', 'cls', ?1, 45, 2, 2500, 'scheduled', ?2),
                    ('s-open', 'cls', ?1, 45, 10, 2500, 'scheduled', ?2),
                    ('s-past', 'cls', ?2, 45, 10, 2500, 'scheduled', ?2),
                    ('s-cancelled', 'cls', ?1, 45, 10, 2500, 'cancelled', ?2)`, FUTURE, PAST);
}

const baseArgs = { waiverVersion: 'test-1', photoConsent: true, medicalNotes: '' };

function book(userId, childId, sessionIds) {
  return createPendingBooking(env, { userId, childId, sessionIds, ...baseArgs });
}

await seed();

test('books up to capacity, then reports the full session', async () => {
  const first = await book('u1', 'c1', ['s-two']);
  assert.ok(first.id, 'first seat should book');
  const second = await book('u2', 'c2', ['s-two']);
  assert.ok(second.id, 'second seat should book');

  const third = await book('u1', 'c1', ['s-two']);
  assert.equal(third.error, 'unavailable');
  assert.equal(third.sessions[0].reason, 'full');
});

test('multi-session booking with one full session rolls back entirely', async () => {
  // s-two is now full; pair it with s-open and bypass the pre-check by
  // deleting one blocker AFTER load... simpler: call with both and assert no
  // partial rows exist for the open session either.
  const result = await book('u2', 'c2', ['s-open', 's-two']);
  assert.ok(result.error, 'booking should fail');

  const partial = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM booking_sessions WHERE session_id = 's-open'`,
  ).first();
  assert.equal(partial.n, 0, 'no seats may be held in the open session after rollback');

  const orphans = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bookings b WHERE NOT EXISTS
       (SELECT 1 FROM booking_sessions bs WHERE bs.booking_id = b.id)`,
  ).first();
  assert.equal(orphans.n, 0, 'no seatless booking rows may survive');
});

test('past and cancelled sessions are not bookable', async () => {
  const past = await book('u1', 'c1', ['s-past']);
  assert.equal(past.error, 'unavailable');
  assert.equal(past.sessions[0].reason, 'past');

  const cancelled = await book('u1', 'c1', ['s-cancelled']);
  assert.equal(cancelled.error, 'unavailable');
  assert.equal(cancelled.sessions[0].reason, 'unavailable');
});

test('expired hold frees the seat', async () => {
  const blocked = await book('u1', 'c1', ['s-two']);
  assert.ok(blocked.error, 's-two starts full');

  // Lapse c1's own hold specifically, so the rebooking below is neither
  // blocked by capacity nor by the duplicate-child guard.
  const holder = await env.DB.prepare(
    `SELECT b.id FROM bookings b JOIN booking_sessions bs ON bs.booking_id = b.id
     WHERE bs.session_id = 's-two' AND b.status = 'pending' AND b.child_id = 'c1' LIMIT 1`,
  ).first();
  await expireBooking(env, holder.id);

  const rebook = await book('u1', 'c1', ['s-two']);
  assert.ok(rebook.id, 'freed seat should be bookable');
});

test('concurrent burst for the last seats never oversells', async () => {
  await env.DB.prepare(
    `INSERT INTO class_sessions (id, class_id, starts_at, duration_mins, capacity, price_cents, status, created_at)
     VALUES ('s-race', 'cls', ?1, 45, 3, 2500, 'scheduled', ?2)`,
  ).bind(FUTURE, PAST).run();
  // Eight distinct children racing (the per-child duplicate guard would
  // otherwise dominate the outcome).
  for (let i = 0; i < 8; i += 1) {
    await env.DB.prepare(
      `INSERT INTO children (id, user_id, name, dob, created_at) VALUES (?1, 'u1', ?2, '2025-09-01', ?3)`,
    ).bind(`c-race-${i}`, `Racer ${i}`, PAST).run();
  }

  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, i) => book('u1', `c-race-${i}`, ['s-race'])),
  );
  const succeeded = attempts.filter((a) => a.id).length;
  assert.equal(succeeded, 3, `exactly capacity bookings may succeed (got ${succeeded})`);

  const held = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM booking_sessions WHERE session_id = 's-race'`,
  ).first();
  assert.equal(held.n, 3, 'seats held must equal capacity');

  const losers = attempts.filter((a) => a.error);
  assert.equal(losers.length, 5);
  for (const loser of losers) {
    assert.ok(['capacity', 'unavailable'].includes(loser.error));
  }
});

test('the same child cannot be double-booked into one session', async () => {
  await env.DB.prepare(
    `INSERT INTO class_sessions (id, class_id, starts_at, duration_mins, capacity, price_cents, status, created_at)
     VALUES ('s-dup', 'cls', ?1, 45, 10, 2500, 'scheduled', ?2)`,
  ).bind(FUTURE, PAST).run();

  const first = await book('u1', 'c1', ['s-dup']);
  assert.ok(first.id, 'first booking succeeds');

  const dup = await book('u1', 'c1', ['s-dup']);
  assert.equal(dup.error, 'already_booked');
  assert.equal(dup.sessions[0].reason, 'already_booked');

  // A different child (even of the same parent) is fine.
  await env.DB.prepare(
    `INSERT INTO children (id, user_id, name, dob, created_at) VALUES ('c1b', 'u1', 'Sib', '2026-01-01', ?1)`,
  ).bind(PAST).run();
  const sibling = await book('u1', 'c1b', ['s-dup']);
  assert.ok(sibling.id, 'sibling can book the same session');

  assert.deepEqual([...await sessionsAlreadyBookedForChild(env, 'c1', ['s-dup'])], ['s-dup']);
});

test('concurrent duplicate attempts for one child resolve to a single booking', async () => {
  await env.DB.prepare(
    `INSERT INTO class_sessions (id, class_id, starts_at, duration_mins, capacity, price_cents, status, created_at)
     VALUES ('s-dup-race', 'cls', ?1, 45, 10, 2500, 'scheduled', ?2)`,
  ).bind(FUTURE, PAST).run();

  const attempts = await Promise.all(
    Array.from({ length: 4 }, () => book('u1', 'c1', ['s-dup-race'])),
  );
  assert.equal(attempts.filter((a) => a.id).length, 1, 'exactly one duplicate attempt may win');

  const held = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM booking_sessions WHERE session_id = 's-dup-race'`,
  ).first();
  assert.equal(held.n, 1);
});

test('availability snapshot reflects holds', async () => {
  const [snap] = await loadSessionsForBooking(env, ['s-race']);
  assert.equal(snap.seats_held, 3);
  assert.equal(snap.bookable, false);
  assert.equal(snap.reason, 'full');
});
