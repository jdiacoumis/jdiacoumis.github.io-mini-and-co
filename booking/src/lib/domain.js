// Domain-level booking logic: capacity-safe reservation, expiry handling,
// confirmation workflow shared by the Stripe webhook, the mock payment
// driver, and the admin mark-as-paid action.

import { uuid, nowIso, isoPlusSeconds } from './db.js';
import { logEvent, logError } from './log.js';

export const PENDING_BOOKING_EXPIRY_SECS = 35 * 60; // Stripe Checkout expires at 30 min

// Seats held against a session: confirmed bookings always, pending bookings
// only while their payment hold has not lapsed. Used inline in guards below —
// keep the two copies in sync.
const HELD_SEATS_SQL = `
  SELECT COUNT(*) FROM bookings b
  JOIN booking_sessions bs ON bs.booking_id = b.id
  WHERE bs.session_id = cs.id
    AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.expires_at > ?#NOW#))`;

// Load the sessions a parent is trying to book, with bookability flags.
// Returns rows: { id, starts_at, duration_mins, price_cents, capacity,
//                 class_name, venue, seats_held, bookable, reason }.
export async function loadSessionsForBooking(env, sessionIds) {
  if (!sessionIds.length) return [];
  const now = nowIso();
  const placeholders = sessionIds.map((_, i) => `?${i + 2}`).join(', ');
  const result = await env.DB.prepare(
    `SELECT cs.id, cs.starts_at, cs.duration_mins, cs.price_cents, cs.capacity,
            cs.status, c.active AS class_active, c.name AS class_name, c.venue,
            (${HELD_SEATS_SQL.replace('?#NOW#', '?1')}) AS seats_held
     FROM class_sessions cs
     JOIN classes c ON c.id = cs.class_id
     WHERE cs.id IN (${placeholders})`,
  ).bind(now, ...sessionIds).all();

  const byId = new Map((result.results || []).map((r) => [r.id, r]));
  return sessionIds.map((id) => {
    const row = byId.get(id);
    if (!row) return { id, bookable: false, reason: 'not_found' };
    let reason = null;
    if (row.status !== 'scheduled' || !row.class_active) reason = 'unavailable';
    else if (row.starts_at <= now) reason = 'past';
    else if (row.seats_held >= row.capacity) reason = 'full';
    return { ...row, bookable: !reason, reason };
  });
}

// Create a pending booking holding seats in one or more sessions, atomically.
//
// D1 has no interactive transactions; a batch() is atomic and rolls back
// entirely if any statement errors. Each per-session insert is guarded by the
// live seat count, and the final txn_guards insert computes 'ok' only when
// every requested seat was actually taken — any other value violates the
// table's CHECK constraint and aborts (rolls back) the whole batch. This is
// what makes two parents racing for the last seat resolve to exactly one
// reservation (booking-flow spec: Capacity-Guarded Seat Reservation).
export async function createPendingBooking(env, {
  userId, childId, sessionIds, waiverVersion, photoConsent, medicalNotes,
}) {
  const unique = [...new Set(sessionIds)];
  const sessions = await loadSessionsForBooking(env, unique);
  const unavailable = sessions.filter((s) => !s.bookable);
  if (unavailable.length) {
    return { error: 'unavailable', sessions: unavailable };
  }

  const bookingId = uuid();
  const now = nowIso();
  const expiresAt = isoPlusSeconds(PENDING_BOOKING_EXPIRY_SECS);
  const amountCents = sessions.reduce((sum, s) => sum + s.price_cents, 0);

  const statements = [
    env.DB.prepare(
      `INSERT INTO bookings
         (id, user_id, child_id, status, amount_cents, currency,
          waiver_version, waiver_accepted_at, photo_consent_snapshot,
          medical_notes_snapshot, created_at, expires_at)
       VALUES (?1, ?2, ?3, 'pending', ?4, 'AUD', ?5, ?6, ?7, ?8, ?6, ?9)`,
    ).bind(bookingId, userId, childId, amountCents, waiverVersion, now,
      photoConsent ? 1 : 0, medicalNotes, expiresAt),

    ...unique.map((sessionId) => env.DB.prepare(
      `INSERT INTO booking_sessions (booking_id, session_id)
       SELECT ?1, cs.id FROM class_sessions cs
       JOIN classes c ON c.id = cs.class_id
       WHERE cs.id = ?2 AND cs.status = 'scheduled' AND c.active = 1
         AND cs.starts_at > ?3
         AND cs.capacity > (${HELD_SEATS_SQL.replace('?#NOW#', '?3')})`,
    ).bind(bookingId, sessionId, now)),

    env.DB.prepare(
      `INSERT INTO txn_guards (id)
       SELECT CASE WHEN (SELECT COUNT(*) FROM booking_sessions WHERE booking_id = ?1) = ?2
              THEN 'ok' ELSE 'capacity' END`,
    ).bind(bookingId, unique.length),

    env.DB.prepare(`DELETE FROM txn_guards WHERE id = 'ok'`),
  ];

  try {
    await env.DB.batch(statements);
  } catch (err) {
    // CHECK violation on txn_guards: a seat was lost to a concurrent booking
    // between page load and submit. Report which sessions are now full.
    const after = await loadSessionsForBooking(env, unique);
    const lost = after.filter((s) => !s.bookable);
    logEvent('booking_capacity_conflict', { user_id: userId.slice(0, 8) });
    return { error: 'capacity', sessions: lost.length ? lost : after };
  }

  logEvent('pending_booking_created', {
    booking_id: bookingId.slice(0, 8),
    sessions: unique.length,
    amount_cents: amountCents,
  });
  return { id: bookingId, expiresAt, amountCents, sessions };
}

// Record the payment handle on a freshly created pending booking.
export async function attachPaymentRef(env, bookingId, provider, paymentRef) {
  await env.DB.prepare(
    `UPDATE bookings SET payment_provider = ?2, payment_ref = ?3 WHERE id = ?1`,
  ).bind(bookingId, provider, paymentRef).run();
}

// Confirm a booking: mark as confirmed and store payment details. Idempotent —
// a second confirmation for an already-confirmed booking leaves the original
// payment record untouched. Cancelled/expired bookings are never confirmed by
// this path (admin "check payment" decides those cases explicitly).
export async function confirmBooking(env, bookingId, { paymentProvider, paymentRef = null, paymentIntent = null, amountCents = null }) {
  const now = nowIso();

  const booking = await env.DB.prepare(
    `SELECT user_id, child_id, status FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();
  if (!booking) return { error: 'not_found' };

  if (booking.status === 'confirmed') {
    logEvent('confirm_booking_idempotent', { booking_id: bookingId.slice(0, 8) });
    return { success: true, alreadyConfirmed: true };
  }
  if (booking.status === 'cancelled') return { error: 'cancelled' };

  // 'pending' or 'expired' (payment can land after the hold lapsed — the
  // money is real, so the booking is honoured).
  const result = await env.DB.prepare(
    `UPDATE bookings
     SET status = 'confirmed',
         payment_provider = ?2,
         payment_ref = COALESCE(?3, payment_ref),
         payment_intent = COALESCE(?4, payment_intent),
         paid_at = ?5,
         amount_cents = COALESCE(?6, amount_cents)
     WHERE id = ?1 AND status IN ('pending', 'expired')`,
  ).bind(bookingId, paymentProvider, paymentRef, paymentIntent, now, amountCents).run();

  if (result.meta.changes === 0) {
    return { error: 'state_changed' };
  }

  logEvent('booking_confirmed', {
    booking_id: bookingId.slice(0, 8),
    provider: paymentProvider,
  });
  return { success: true };
}

// A booking with its child and sessions, visible ONLY to the owning account.
// Missing and not-owned ids return the same null (no cross-account disclosure,
// CWE-639 / API1 BOLA).
export async function getOwnedBooking(env, bookingId, userId) {
  const booking = await env.DB.prepare(
    `SELECT b.id, b.status, b.amount_cents, b.currency, b.paid_at, b.created_at,
            b.expires_at, b.payment_provider, b.waiver_version,
            b.photo_consent_snapshot, c.name AS child_name
     FROM bookings b
     JOIN children c ON c.id = b.child_id
     WHERE b.id = ?1 AND b.user_id = ?2`,
  ).bind(bookingId, userId).first();
  if (!booking) return null;

  const sessions = await env.DB.prepare(
    `SELECT cs.id, cs.starts_at, cs.duration_mins, cs.price_cents, cl.name AS class_name, cl.venue
     FROM booking_sessions bs
     JOIN class_sessions cs ON cs.id = bs.session_id
     JOIN classes cl ON cl.id = cs.class_id
     WHERE bs.booking_id = ?1
     ORDER BY cs.starts_at`,
  ).bind(bookingId).all();

  return { ...booking, sessions: sessions.results || [] };
}

// Effective status: a pending booking past its hold is shown (and treated) as
// expired even before the sweep has updated the row.
export function effectiveStatus(booking, now = nowIso()) {
  if (booking.status === 'pending' && booking.expires_at && booking.expires_at <= now) {
    return 'expired';
  }
  return booking.status;
}

// All bookings for an account's dashboard, newest first, with session times.
export async function listUserBookings(env, userId) {
  const rows = await env.DB.prepare(
    `SELECT b.id, b.status, b.amount_cents, b.paid_at, b.created_at, b.expires_at,
            c.name AS child_name,
            (SELECT GROUP_CONCAT(cs.starts_at, '|') FROM booking_sessions bs
             JOIN class_sessions cs ON cs.id = bs.session_id
             WHERE bs.booking_id = b.id) AS session_starts
     FROM bookings b
     JOIN children c ON c.id = b.child_id
     WHERE b.user_id = ?1
     ORDER BY b.created_at DESC
     LIMIT 100`,
  ).bind(userId).all();
  return rows.results || [];
}

// Mark a booking expired (seat released).
export async function expireBooking(env, bookingId) {
  await env.DB.prepare(
    `UPDATE bookings SET status = 'expired' WHERE id = ?1 AND status = 'pending'`,
  ).bind(bookingId).run();
}

// Opportunistic cleanup: lapse old pending bookings so they stop holding seats.
// Read paths already exclude lapsed holds, so this is tidiness, not correctness.
export async function sweepExpiredBookings(env) {
  const now = nowIso();
  const result = await env.DB.prepare(
    `UPDATE bookings SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= ?1`,
  ).bind(now).run();
  if (result.meta.changes > 0) {
    logEvent('bookings_swept', { count: result.meta.changes });
  }
}

// Public class list: active classes with their upcoming scheduled sessions and
// live availability.
export async function listOpenClasses(env) {
  const now = nowIso();
  const rows = await env.DB.prepare(
    `SELECT c.id AS class_id, c.name, c.description, c.venue, c.age_range,
            cs.id AS session_id, cs.starts_at, cs.duration_mins, cs.price_cents, cs.capacity,
            (${HELD_SEATS_SQL.replace('?#NOW#', '?1')}) AS seats_held
     FROM classes c
     JOIN class_sessions cs ON cs.class_id = c.id
     WHERE c.active = 1 AND cs.status = 'scheduled' AND cs.starts_at > ?1
     ORDER BY c.name, cs.starts_at`,
  ).bind(now).all();

  const classes = new Map();
  for (const row of rows.results || []) {
    if (!classes.has(row.class_id)) {
      classes.set(row.class_id, {
        id: row.class_id,
        name: row.name,
        description: row.description,
        venue: row.venue,
        ageRange: row.age_range,
        sessions: [],
      });
    }
    classes.get(row.class_id).sessions.push({
      id: row.session_id,
      startsAt: row.starts_at,
      durationMins: row.duration_mins,
      priceCents: row.price_cents,
      capacity: row.capacity,
      seatsHeld: row.seats_held,
      seatsLeft: Math.max(0, row.capacity - row.seats_held),
    });
  }
  return [...classes.values()];
}

export function formatAud(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
