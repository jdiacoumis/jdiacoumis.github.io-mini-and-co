// Core scheduled jobs (design D10), run every 15 minutes by lib/cron.js:
//   sweepExpiredBookings — lapse pending holds, returning credits and
//                          voucher uses;
//   expireOffers         — waitlist offers past their deadline release the
//                          held booking and go back to 'waiting';
//   purge                — delete sign-in tokens, web sessions, rate-limit
//                          windows and webhook events older than 30 days.
// All three are idempotent.

import { sweepExpiredBookings, expireBooking } from '../domain.js';
import { isoFromMs } from '../db.js';
import { formatSydney } from '../time.js';
import { logEvent } from '../log.js';

export const RETENTION_DAYS = 30;

// Waitlist offers whose deadline has passed: if the offer was paid, the entry
// is 'booked'; otherwise the held booking expires (seat released) and the
// entry returns to 'waiting' with the lapse noted. offer_booking_id is kept,
// so a payment that still lands later marks the entry booked.
export async function expireOffers(env, { now }) {
  const rows = (await env.DB.prepare(
    `SELECT w.id, w.offer_booking_id, b.status AS booking_status
     FROM waitlist w LEFT JOIN bookings b ON b.id = w.offer_booking_id
     WHERE w.status = 'offered' AND w.offer_expires_at <= ?1
     LIMIT 200`,
  ).bind(now).all()).results || [];

  let lapsed = 0;
  let booked = 0;
  for (const row of rows) {
    if (row.booking_status === 'confirmed') {
      await env.DB.prepare(
        `UPDATE waitlist SET status = 'booked', resolved_at = ?2 WHERE id = ?1 AND status = 'offered'`,
      ).bind(row.id, now).run();
      booked += 1;
      continue;
    }
    if (row.offer_booking_id && row.booking_status === 'pending') {
      await expireBooking(env, row.offer_booking_id);
    }
    const note = `Offer lapsed ${formatSydney(now, 'date')}.`;
    const result = await env.DB.prepare(
      `UPDATE waitlist SET status = 'waiting', offered_at = NULL, offer_expires_at = NULL,
              note = TRIM(note || ' ' || ?3)
       WHERE id = ?1 AND status = 'offered' AND offer_expires_at <= ?2`,
    ).bind(row.id, now, note).run();
    lapsed += result.meta.changes;
  }
  if (lapsed || booked) logEvent('waitlist_offers_expired', { lapsed, booked });
  return { lapsed, booked };
}

export async function purgeOldRecords(env, { now }) {
  const cutoffMs = Date.parse(now) - RETENTION_DAYS * 86400 * 1000;
  const cutoff = isoFromMs(cutoffMs);
  const cutoffUnix = Math.floor(cutoffMs / 1000);
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM auth_tokens WHERE created_at < ?1`).bind(cutoff),
    env.DB.prepare(`DELETE FROM web_sessions WHERE created_at < ?1`).bind(cutoff),
    env.DB.prepare(`DELETE FROM rate_limits WHERE CAST(window_start AS INTEGER) < ?1`).bind(cutoffUnix),
    env.DB.prepare(`DELETE FROM webhook_events WHERE received_at < ?1`).bind(cutoff),
  ]);
  const [tokens, sessions, rateLimits, webhookEvents] = results.map((r) => r.meta.changes);
  return { tokens, sessions, rateLimits, webhookEvents };
}

export const jobs = [
  { name: 'sweepExpiredBookings', run: async (env, { now }) => ({ expired: await sweepExpiredBookings(env, { now }) }) },
  { name: 'expireOffers', run: expireOffers },
  { name: 'purge', run: purgeOldRecords },
];
