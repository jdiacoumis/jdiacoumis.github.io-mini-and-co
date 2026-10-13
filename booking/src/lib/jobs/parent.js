// Parent-facing scheduled jobs (Phase 2A, design D10), run every 15 minutes
// by lib/cron.js. Each job: { name, run: async (env, { now }) => result }.
//
//   trialFollowUps — the day after a trial class (its session started at
//   least 20 hours ago, and within the last week), email the family ONE offer
//   of the rest of that term at the pro-rata price (prepareBooking — the same
//   price and eligibility the checkout would give), or the term's waitlist
//   when it is full. Nothing is sent when the child has since booked the
//   rest of the term, the term has finished or closed, the trial session was
//   cancelled, or the child was marked absent — those are filtered in SQL,
//   newest trials first, so rows that can never be sent don't crowd the
//   batch. Idempotent: the email_log dedupe key trial_followup:<booking id>
//   sends it at most once (a failed send is retried by a later run).

import { prepareBooking, bookingLiveSql } from '../domain.js';
import { instalmentSchedule } from '../pricing.js';
import { isoFromMs } from '../db.js';
import { sendTemplate } from '../notify.js';
import { trialFollowUpEmail } from '../emails/parent.js';
import { logEvent } from '../log.js';

export const TRIAL_FOLLOW_UP_AFTER_HOURS = 20;
export const TRIAL_FOLLOW_UP_WINDOW_DAYS = 7;
const BATCH = 50;

// What the follow-up offers: the rest of the term, or its waitlist when full.
// null = nothing to offer (already booked, finished, closed, not open, …).
async function followUpOffer(env, row, now) {
  const prepared = await prepareBooking(env, {
    userId: row.user_id, childId: row.child_id, kind: 'term', termId: row.term_id, now,
  });
  if (!prepared.ok) return prepared.error === 'full' ? { isFull: true } : null;
  const { quote, sessions } = prepared;
  let plan = null;
  if (quote.planOption && quote.amountCents > 0) {
    const schedule = instalmentSchedule(quote.amountCents, quote.planOption.n, quote.planOption.interval, now);
    plan = { ...quote.planOption, eachCents: schedule.eachCents, firstCents: schedule.firstCents };
  }
  return {
    isFull: false,
    weeks: quote.weeks,
    listCents: quote.listCents,
    amountCents: quote.amountCents,
    creditCents: quote.creditCents,
    plan,
    nextStartsAt: sessions.length ? sessions[0].starts_at : null,
  };
}

export async function sendTrialFollowUps(env, { now }) {
  const nowMs = Date.parse(now);
  const cutoff = isoFromMs(nowMs - TRIAL_FOLLOW_UP_AFTER_HOURS * 3600 * 1000);
  const floor = isoFromMs(nowMs - TRIAL_FOLLOW_UP_WINDOW_DAYS * 86400 * 1000);
  const rows = (await env.DB.prepare(
    `SELECT b.id AS booking_id, b.user_id, b.child_id, b.term_id, u.email, u.name AS parent_name,
            ch.name AS child_name, t.name AS term_name, c.name AS class_name
     FROM bookings b
     JOIN booking_sessions bs ON bs.booking_id = b.id AND bs.status = 'booked'
     JOIN class_sessions cs ON cs.id = bs.session_id
     JOIN users u ON u.id = b.user_id
     JOIN children ch ON ch.id = b.child_id
     JOIN terms t ON t.id = b.term_id
     JOIN classes c ON c.id = t.class_id
     WHERE b.kind = 'trial' AND b.status = 'confirmed'
       AND cs.status = 'scheduled' AND cs.starts_at <= ?1 AND cs.starts_at > ?2
       AND (bs.attendance IS NULL OR bs.attendance = 'present')
       AND ch.archived_at IS NULL
       AND t.status = 'open'
       AND EXISTS (SELECT 1 FROM class_sessions us
                   WHERE us.term_id = t.id AND us.status = 'scheduled' AND us.starts_at > ?3)
       AND NOT EXISTS (SELECT 1 FROM bookings tb
                       WHERE tb.child_id = b.child_id AND tb.term_id = b.term_id AND tb.kind = 'term'
                         AND ${bookingLiveSql('tb', '?3')})
       AND NOT EXISTS (SELECT 1 FROM email_log el
                       WHERE el.dedupe_key = 'trial_followup:' || b.id AND el.status = 'sent')
     ORDER BY cs.starts_at DESC
     LIMIT ${BATCH}`,
  ).bind(cutoff, floor, now).all()).results || [];

  let sent = 0;
  let skipped = 0;
  for (const row of rows) {
    const offer = await followUpOffer(env, row, now);
    if (!offer) {
      skipped += 1;
      continue;
    }
    const base = env.PUBLIC_BASE_URL;
    const message = trialFollowUpEmail({
      parentName: row.parent_name,
      childName: row.child_name,
      className: row.class_name,
      termName: row.term_name,
      offer,
      bookUrl: `${base}/book/checkout?kind=term&term=${encodeURIComponent(row.term_id)}&child=${encodeURIComponent(row.child_id)}`,
      waitlistUrl: `${base}/book/waitlist?term=${encodeURIComponent(row.term_id)}`,
      classesUrl: `${base}/book`,
    });
    const result = await sendTemplate(env, {
      template: 'trial_followup', to: row.email, userId: row.user_id, bookingId: row.booking_id,
      termId: row.term_id, dedupeKey: `trial_followup:${row.booking_id}`, ...message,
    });
    if (result.sent) sent += 1; else skipped += 1;
  }
  if (sent) logEvent('trial_followups_sent', { sent });
  return { sent, skipped };
}

export const jobs = [
  { name: 'trialFollowUps', run: sendTrialFollowUps },
];
