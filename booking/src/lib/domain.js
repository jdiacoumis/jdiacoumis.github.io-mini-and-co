// Domain-level booking logic: capacity-safe reservation, expiry handling,
// confirmation workflow shared by webhook and mock payment driver.

import { uuid, nowIso, isoPlusSeconds } from './db.js';
import { logEvent, logError, maskEmail } from './log.js';

const PENDING_BOOKING_EXPIRY_SECS = 35 * 60; // 35 minutes (Stripe Checkout = 30 min)

// Create a booking with capacity-safe seat reservation via guarded insert.
// Returns { id, expiresAt } on success, or { error } on capacity conflict.
export async function createPendingBooking(env, userId, childId, sessionId) {
  const bookingId = uuid();
  const now = nowIso();
  const expiresAt = isoPlusSeconds(PENDING_BOOKING_EXPIRY_SECS);

  // Read session price once to store in the booking.
  const session = await env.DB.prepare(
    `SELECT price_cents, capacity FROM class_sessions WHERE id = ?1`,
  ).bind(sessionId).first();

  if (!session) {
    return { error: 'Session not found' };
  }

  // Capacity-guarded insert: only succeeds if (confirmed + unexpired pending) < capacity.
  // Uses a single batch() so it's atomic; D1 has no interactive txns.
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO booking_sessions (booking_id, session_id)
       SELECT ?1, ?2
       WHERE (SELECT capacity FROM class_sessions WHERE id = ?2)
         > (SELECT COUNT(*) FROM bookings b
            JOIN booking_sessions bs ON b.id = bs.booking_id
            WHERE bs.session_id = ?2
              AND b.status IN ('confirmed', 'pending')
              AND (b.status = 'confirmed' OR b.expires_at > ?3))`,
    ).bind(bookingId, sessionId, now),

    env.DB.prepare(
      `INSERT INTO bookings (id, user_id, child_id, status, amount_cents, currency, created_at, expires_at)
       VALUES (?1, ?2, ?3, 'pending', ?4, 'AUD', ?5, ?6)`,
    ).bind(bookingId, userId, childId, session.price_cents, now, expiresAt),
  ]);

  // If no rows affected on the first insert, the seat was lost (capacity full).
  if (result[0].success && result[0].meta.changes === 0) {
    return { error: 'Session is now full' };
  }

  if (!result[0].success || !result[1].success) {
    logError('booking_create_failed', new Error('Batch failed'), {
      user_id: userId,
      child_id: childId,
      session_id: sessionId,
    });
    return { error: 'Could not create booking' };
  }

  logEvent('pending_booking_created', { booking_id: bookingId.slice(0, 8) });
  return { id: bookingId, expiresAt, amountCents: session.price_cents };
}

// Get pending booking by id, checking expiry.
export async function getPendingBooking(env, bookingId) {
  const now = nowIso();
  return env.DB.prepare(
    `SELECT id, user_id, child_id, amount_cents, status, created_at, expires_at
     FROM bookings
     WHERE id = ?1 AND status = 'pending' AND expires_at > ?2`,
  ).bind(bookingId, now).first();
}

// Confirm a booking: mark as confirmed, store payment details, optionally emit CAPI event.
export async function confirmBooking(
  env,
  bookingId,
  { paymentProvider, paymentRef, paymentIntent, amountCents },
) {
  const now = nowIso();

  const booking = await env.DB.prepare(
    `SELECT user_id, child_id, status FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();

  if (!booking) {
    return { error: 'Booking not found' };
  }

  if (booking.status !== 'pending') {
    logEvent('confirm_booking_already_confirmed', { booking_id: bookingId.slice(0, 8) });
    // Idempotent: return success even if already confirmed.
    return { success: true };
  }

  const result = await env.DB.prepare(
    `UPDATE bookings
     SET status = 'confirmed',
         payment_provider = ?2,
         payment_ref = ?3,
         payment_intent = ?4,
         paid_at = ?5,
         amount_cents = ?6
     WHERE id = ?1 AND status = 'pending'`,
  ).bind(bookingId, paymentProvider, paymentRef, paymentIntent, now, amountCents).run();

  if (result.success && result.meta.changes === 0) {
    return { error: 'Booking is no longer pending' };
  }

  logEvent('booking_confirmed', {
    booking_id: bookingId.slice(0, 8),
    provider: paymentProvider,
  });

  // Fetch the confirmed booking for the caller (includes user_id for email lookup).
  const confirmed = await env.DB.prepare(
    `SELECT id, user_id, child_id, amount_cents, payment_ref, status
     FROM bookings WHERE id = ?1`,
  ).bind(bookingId).first();

  return { success: true, booking: confirmed };
}

// Mark a booking expired (seat released).
export async function expireBooking(env, bookingId) {
  await env.DB.prepare(
    `UPDATE bookings SET status = 'expired' WHERE id = ?1 AND status = 'pending'`,
  ).bind(bookingId).run();
}

// Opportunistic cleanup: expire old pending bookings (so they don't hold seats).
export async function sweepExpiredBookings(env) {
  const now = nowIso();
  const result = await env.DB.prepare(
    `UPDATE bookings SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= ?1`,
  ).bind(now).run();

  if (result.success && result.meta.changes > 0) {
    logEvent('bookings_swept', { count: result.meta.changes });
  }
}

// Count confirmed seats for a session (excludes pending unless explicitly included).
export async function countSeats(env, sessionId, includePending = false) {
  const sql = `
    SELECT COUNT(*) as count
    FROM bookings b
    JOIN booking_sessions bs ON b.id = bs.booking_id
    WHERE bs.session_id = ?1
      AND (b.status = 'confirmed' OR (?2 AND b.status = 'pending' AND b.expires_at > datetime('now')))
  `;
  const row = await env.DB.prepare(sql).bind(sessionId, includePending ? 1 : 0).first();
  return row?.count ?? 0;
}

// Get fullness (seats used / capacity) for a session.
export async function getSessionFullness(env, sessionId) {
  const row = await env.DB.prepare(
    `SELECT
       cs.capacity,
       (SELECT COUNT(*) FROM bookings b
        JOIN booking_sessions bs ON b.id = bs.booking_id
        WHERE bs.session_id = cs.id AND b.status = 'confirmed') as used
     FROM class_sessions cs
     WHERE cs.id = ?1`,
  ).bind(sessionId).first();

  if (!row) return null;

  return {
    used: row.used,
    capacity: row.capacity,
    available: row.capacity - row.used,
    percentage: Math.round((row.used / row.capacity) * 100),
  };
}
