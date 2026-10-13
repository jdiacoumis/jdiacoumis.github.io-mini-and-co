// Owner-operations scheduled jobs (design D10), run every 15 minutes by
// lib/cron.js after the core jobs (sweep, expireOffers, purge):
//
//   sendReminders     — the day-before reminder: one email per (session,
//                       booking) for confirmed bookings' booked rows in
//                       scheduled sessions starting 20–28 hours from now
//                       (dedupe reminder:<session>:<booking>). Cancelled
//                       sessions, cancelled or transferred weeks and unpaid
//                       holds get nothing.
//   overdueNudges     — while a plan stays overdue AND its subscription is
//                       still live (Stripe may still take the card), the
//                       family is reminded at most once every 7 days (no
//                       earlier than 7 days after the failure notice), dedupe
//                       plan_overdue:<booking>:<ISO week>. A plan whose
//                       subscription has ended — Stripe gave up, or the owner
//                       stopped it or marked it sorted — gets none: "update
//                       your card" would change nothing (review finding 5).
//   reconcileWaitlist — waitlist entries whose offer booking is confirmed are
//                       marked booked (confirmBooking already does this for
//                       every payment path; this catches anything else).
//
// Every job is idempotent: the email_log dedupe keys make a second run (or an
// overlapping one) send nothing new, and failed sends are retried.

import { sendTemplate, tallySends } from '../notify.js';
import { reminder, planFailed } from '../emails/ops.js';
import { isoFromMs } from '../db.js';
import { sydneyFields } from '../time.js';
import { planExpectedCents } from '../pricing.js';
import { ledgerTotals } from '../ledger.js';
import { logEvent } from '../log.js';

export const REMINDER_FROM_HOURS = 20;
export const REMINDER_TO_HOURS = 28;
export const NUDGE_EVERY_DAYS = 7;
const MAX_PER_RUN = 200;

// The reminder window for a run at `now`: sessions starting in [from, to].
export function reminderWindow(now) {
  const t = Date.parse(now);
  return {
    from: isoFromMs(t + REMINDER_FROM_HOURS * 3600 * 1000),
    to: isoFromMs(t + REMINDER_TO_HOURS * 3600 * 1000),
  };
}

// ISO-8601 week of the Australia/Sydney calendar date of `now`, e.g.
// '2026-W42' (weeks start on Monday; week 1 holds the year's first Thursday).
export function isoWeekKey(now) {
  const [y, m, d] = sydneyFields(now).date.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = date.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  date.setUTCDate(date.getUTCDate() + 4 - weekday); // that week's Thursday
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export async function sendReminders(env, { now }) {
  const { from, to } = reminderWindow(now);
  const rows = (await env.DB.prepare(
    `SELECT bs.session_id, b.id AS booking_id, b.user_id, b.term_id, u.email, u.name AS parent_name,
            ch.name AS child_name, c.name AS class_name, c.venue, cs.starts_at
     FROM booking_sessions bs
     JOIN class_sessions cs ON cs.id = bs.session_id
     JOIN classes c ON c.id = cs.class_id
     JOIN bookings b ON b.id = bs.booking_id
     JOIN users u ON u.id = b.user_id
     JOIN children ch ON ch.id = b.child_id
     WHERE cs.status = 'scheduled' AND cs.starts_at >= ?1 AND cs.starts_at <= ?2
       AND bs.status = 'booked' AND b.status = 'confirmed'
       AND NOT EXISTS (SELECT 1 FROM email_log el
                       WHERE el.dedupe_key = 'reminder:' || bs.session_id || ':' || b.id AND el.status = 'sent')
     ORDER BY cs.starts_at, b.id
     LIMIT ?3`,
  ).bind(from, to, MAX_PER_RUN).all()).results || [];

  const accountUrl = `${env.PUBLIC_BASE_URL}/account`;
  const results = [];
  for (const r of rows) {
    const message = reminder({
      parentName: r.parent_name, childName: r.child_name, className: r.class_name,
      startsAt: r.starts_at, venue: r.venue, accountUrl,
    });
    results.push(await sendTemplate(env, {
      template: 'reminder', to: r.email, userId: r.user_id, bookingId: r.booking_id, sessionId: r.session_id,
      termId: r.term_id, dedupeKey: `reminder:${r.session_id}:${r.booking_id}`, ...message,
    }));
  }
  const tally = tallySends(results);
  if (rows.length) logEvent('reminders_run', tally);
  return tally;
}

// Money a plan is behind by at `now`: instalments due so far minus money
// received (cards, offline). 0 when it has caught up or cannot be worked out.
export async function planShortfallCents(env, booking, now) {
  if (!booking.plan_instalments || !booking.plan_instalment_cents || !booking.paid_at) return 0;
  const expected = planExpectedCents({
    totalCents: booking.amount_cents, n: booking.plan_instalments, eachCents: booking.plan_instalment_cents,
    interval: booking.plan_interval || 'week', anchorIso: booking.paid_at, now,
  });
  const totals = await ledgerTotals(env, booking.id);
  return Math.max(0, expected - totals.money_in_cents);
}

export async function overdueNudges(env, { now }) {
  const since = isoFromMs(Date.parse(now) - NUDGE_EVERY_DAYS * 86400 * 1000);
  const week = isoWeekKey(now);
  const rows = (await env.DB.prepare(
    `SELECT b.id, b.user_id, b.term_id, b.amount_cents, b.plan_instalments, b.plan_instalment_cents,
            b.plan_interval, b.paid_at, u.email, u.name AS parent_name, ch.name AS child_name
     FROM bookings b
     JOIN users u ON u.id = b.user_id
     JOIN children ch ON ch.id = b.child_id
     WHERE b.status = 'confirmed' AND b.payment_method = 'plan' AND b.payment_status = 'plan_overdue'
       AND b.stripe_subscription_id IS NOT NULL AND b.plan_ended_at IS NULL
       AND (b.needs_attention IS NULL OR b.needs_attention != 'plan_ended_short')
       AND NOT EXISTS (SELECT 1 FROM email_log el
                       WHERE el.booking_id = b.id AND el.template IN ('plan_failed', 'plan_overdue')
                         AND el.status = 'sent' AND el.sent_at > ?1)
     ORDER BY b.id
     LIMIT ?2`,
  ).bind(since, MAX_PER_RUN).all()).results || [];

  const updateCardUrl = `${env.PUBLIC_BASE_URL}/account`;
  const results = [];
  let caughtUp = 0;
  for (const b of rows) {
    const shortfall = await planShortfallCents(env, b, now);
    if (shortfall <= 0) {
      caughtUp += 1; // flagged overdue but nothing is behind: leave it to the owner
      continue;
    }
    const message = planFailed({
      parentName: b.parent_name, childName: b.child_name, amountDueCents: shortfall, updateCardUrl, nudge: true,
    });
    results.push(await sendTemplate(env, {
      template: 'plan_overdue', to: b.email, userId: b.user_id, bookingId: b.id, termId: b.term_id,
      dedupeKey: `plan_overdue:${b.id}:${week}`, ...message,
    }));
  }
  const tally = { ...tallySends(results), caughtUp };
  if (rows.length) logEvent('overdue_nudges_run', tally);
  return tally;
}

export async function reconcileWaitlist(env, { now }) {
  const result = await env.DB.prepare(
    `UPDATE waitlist SET status = 'booked', resolved_at = ?1
     WHERE status IN ('offered', 'waiting') AND offer_booking_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM bookings b WHERE b.id = waitlist.offer_booking_id AND b.status = 'confirmed')`,
  ).bind(now).run();
  const booked = result.meta.changes;
  if (booked) logEvent('waitlist_reconciled', { booked });
  return { booked };
}

export const jobs = [
  { name: 'sendReminders', run: sendReminders },
  { name: 'overdueNudges', run: overdueNudges },
  { name: 'reconcileWaitlist', run: reconcileWaitlist },
];
