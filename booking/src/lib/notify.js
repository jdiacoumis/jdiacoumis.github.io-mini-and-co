// Notifications (design D10): every email the system sends goes through
// sendTemplate(), which writes email_log. A dedupe key makes a send
// idempotent — scheduled jobs and webhook retries can run again safely and a
// family never gets the same email twice. A failed send is logged as 'failed'
// and may be retried by the next run.
//
// Family notices (Phase 2C): notifySessionCancelled() emails every family
// booked into a cancelled session (with the credit they were given) and sends
// the owner a summary; notifyPlanFailed() emails the family an Update card
// link and alerts the owner. Their signatures are fixed — Phase 2B's
// session-cancel route and the payment webhook call them.
//
// Dedupe keys used here (the cron jobs in lib/jobs/ops.js add reminder:… and
// plan_overdue:…):
//   session_cancelled:<session>:<booking>          family notice, once per booking
//   session_cancelled:<session>:<owner email>      owner summary (via notifyOwner)
//   plan_failed:<booking>:<invoice | attempt-N>    family notice, once per invoice
//   plan_failed:<booking>:<invoice>:<attempt>:<owner email>  owner alert, per attempt

import { sendEmail } from './email-driver.js';
import { uuid, nowIso, isoFromMs } from './db.js';
import { logEvent, logError } from './log.js';
import { normaliseEmail, isValidEmail, emailAllowlist } from './validate.js';
import { loadBookingForNotification, bookingLiveSql, formatAud } from './domain.js';
import { formatSydney } from './time.js';
import { ownerAlertEmail, attentionEmail } from './emails/core.js';
import { bookingConfirmationEmail } from './emails/parent.js';
import { sessionCancelled, planFailed } from './emails/ops.js';

// Send one templated email and log it.
//   template: short name for the log ('booking_confirmed', 'reminder', …)
//   dedupeKey: e.g. 'reminder:<session>:<booking>' — a second call with the
//              same key is skipped (unless the first attempt failed)
//   replyTo:   where replies go; omitted → the owner (EMAIL_REPLY_TO, else
//              the first ADMIN_EMAILS address — lib/email-driver.js)
// Returns { sent: true, id } | { skipped: true } | { sent: false, error }.
// Never throws for delivery problems (callers are jobs and webhooks).
export async function sendTemplate(env, {
  template, to, userId = null, bookingId = null, sessionId = null, termId = null,
  dedupeKey = null, subject, text, html: htmlBody = '', replyTo = undefined,
}) {
  const email = normaliseEmail(to);
  if (!isValidEmail(email)) return { sent: false, error: 'invalid_recipient' };
  const now = nowIso();
  let id = uuid();

  const claim = await env.DB.prepare(
    `INSERT INTO email_log (id, template, dedupe_key, to_email, user_id, booking_id, session_id, term_id,
                            subject, status, sent_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'sent', ?10)
     ON CONFLICT(dedupe_key) DO NOTHING`,
  ).bind(id, template, dedupeKey, email, userId, bookingId, sessionId, termId, String(subject).slice(0, 200), now).run();
  if (claim.meta.changes === 0) {
    // Already sent — unless the earlier attempt failed, in which case retry it.
    const retry = await env.DB.prepare(
      `UPDATE email_log SET status = 'sent', error = NULL, sent_at = ?2
       WHERE dedupe_key = ?1 AND status = 'failed' RETURNING id`,
    ).bind(dedupeKey, now).first();
    if (!retry) return { skipped: true };
    id = retry.id;
  }

  try {
    const providerRef = await sendEmail(env, email, subject, text, String(htmlBody || ''), { replyTo });
    if (providerRef) {
      await env.DB.prepare(`UPDATE email_log SET provider_ref = ?2 WHERE id = ?1`).bind(id, String(providerRef)).run();
    }
    logEvent('email_template_sent', { template, booking_id: bookingId ? bookingId.slice(0, 8) : null });
    return { sent: true, id };
  } catch (err) {
    await env.DB.prepare(
      `UPDATE email_log SET status = 'failed', error = ?2 WHERE id = ?1`,
    ).bind(id, String(err && err.message).slice(0, 200)).run();
    logError('email_template_failed', err, { template });
    return { sent: false, error: 'send_failed' };
  }
}

// Tally sendTemplate() outcomes: { sent, skipped, failed }.
export function tallySends(results) {
  const tally = { sent: 0, skipped: 0, failed: 0 };
  for (const r of results) {
    if (r && r.sent) tally.sent += 1;
    else if (r && r.skipped) tally.skipped += 1;
    else tally.failed += 1;
  }
  return tally;
}

// Alert every ADMIN_EMAILS address. With a dedupeKey, each address gets the
// alert at most once.
export async function notifyOwner(env, subject, text, {
  dedupeKey = null, bookingId = null, sessionId = null, termId = null, template = 'owner_alert',
} = {}) {
  const message = ownerAlertEmail({ subject, text });
  return sendToOwners(env, message, { dedupeKey, bookingId, sessionId, termId, template });
}

async function sendToOwners(env, message, { dedupeKey, bookingId, sessionId, termId, template }) {
  const results = [];
  for (const to of emailAllowlist(env.ADMIN_EMAILS)) {
    results.push(await sendTemplate(env, {
      template, to, bookingId, sessionId, termId,
      dedupeKey: dedupeKey ? `${dedupeKey}:${to}` : null,
      subject: message.subject, text: message.text, html: message.html,
    }));
  }
  return results;
}

// The booking confirmation email to the family (once per booking).
export async function notifyBookingConfirmed(env, bookingId) {
  const booking = await loadBookingForNotification(env, bookingId);
  if (!booking || booking.status !== 'confirmed') return { skipped: true };
  const message = bookingConfirmationEmail({ booking, env });
  return sendTemplate(env, {
    template: 'booking_confirmed', to: booking.email, userId: booking.user_id, bookingId,
    termId: booking.term_id, dedupeKey: `booking_confirmed:${bookingId}`, ...message,
  });
}

// Tell the owner a booking was flagged (needs_attention) — once per flag.
export async function notifyAttention(env, bookingId, flag, { detail = '' } = {}) {
  const booking = await loadBookingForNotification(env, bookingId);
  if (!booking) return [];
  logEvent('attention_notified', { booking_id: bookingId.slice(0, 8), flag });
  return sendToOwners(env, attentionEmail({ booking, flag, env, detail }), {
    dedupeKey: `attention:${flag}:${bookingId}`, bookingId, sessionId: null, termId: booking.term_id,
    template: 'owner_attention',
  });
}

// --- Session cancelled -------------------------------------------------------

// A row cancelled more than this long before the session itself was cancelled
// was a single-week cancellation made earlier (already dealt with at the
// time), not part of this cancellation.
const SESSION_CANCEL_WINDOW_SECS = 10 * 60;

// Families to tell about a cancelled session: every booking with a row in the
// session that is 'booked', or was set 'cancelled' as part of this
// cancellation (Phase 2B cancels the rows in the same batch as the credits),
// whose booking is live (confirmed or an unexpired hold) — or was itself
// cancelled as part of it. Rows transferred out, weeks cancelled earlier,
// lapsed holds and long-cancelled bookings are left out. credit_cents is the
// credit issued for this session to this child (or against this booking).
export async function sessionCancelledRecipients(env, session, now = nowIso()) {
  const cutoff = session.cancelled_at
    ? isoFromMs(Date.parse(session.cancelled_at) - SESSION_CANCEL_WINDOW_SECS * 1000)
    : null;
  const rows = await env.DB.prepare(
    `SELECT b.id AS booking_id, b.user_id, b.child_id, b.term_id, b.kind, b.status AS booking_status,
            b.amount_cents, bs.status AS row_status, u.email, u.name AS parent_name, ch.name AS child_name,
            (SELECT COALESCE(SUM(cr.amount_cents), 0) FROM credits cr
             WHERE cr.source_session_id = ?1 AND cr.user_id = b.user_id AND cr.voided_at IS NULL
               AND (cr.source_booking_id = b.id OR cr.child_id = b.child_id)) AS credit_cents
     FROM booking_sessions bs
     JOIN bookings b ON b.id = bs.booking_id
     JOIN users u ON u.id = b.user_id
     JOIN children ch ON ch.id = b.child_id
     WHERE bs.session_id = ?1
       AND (bs.status = 'booked'
            OR (bs.status = 'cancelled' AND (bs.changed_at IS NULL OR ?3 IS NULL OR bs.changed_at >= ?3)))
       AND (${bookingLiveSql('b', '?2')}
            OR (b.status = 'cancelled' AND ?3 IS NOT NULL AND b.cancelled_at >= ?3))
     ORDER BY ch.name, b.id`,
  ).bind(session.id, now, cutoff).all();
  return rows.results || [];
}

// The owner cancelled a session. Call AFTER the session row is
// status = 'cancelled' and the credits are issued (Phase 2B's route does both
// in one batch). Emails each affected family once, with their credit — or,
// for an unpaid place, the price reduction (`priceReductions`: { [bookingId]:
// cents } from cancelSessionWithCredits) — then sends the owner a summary.
// Safe to call again: nobody is emailed twice.
// Returns { families, sent, skipped, failed, creditCents }, plus
// error: 'not_found' | 'not_cancelled' when nothing was sent.
export async function notifySessionCancelled(env, sessionId, { reason = '', priceReductions = {} } = {}) {
  const empty = { families: 0, sent: 0, skipped: 0, failed: 0, creditCents: 0 };
  const session = await env.DB.prepare(
    `SELECT cs.id, cs.starts_at, cs.status, cs.cancelled_at, cs.cancelled_reason, cs.term_id,
            c.name AS class_name, c.venue
     FROM class_sessions cs JOIN classes c ON c.id = cs.class_id
     WHERE cs.id = ?1`,
  ).bind(sessionId).first();
  if (!session) return { ...empty, error: 'not_found' };
  if (session.status !== 'cancelled') {
    // Never tell families a class is cancelled while it is still running.
    logEvent('session_cancelled_notice_skipped', { session_id: String(sessionId).slice(0, 8), reason: 'not_cancelled' });
    return { ...empty, error: 'not_cancelled' };
  }

  const why = String(reason || session.cancelled_reason || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const accountUrl = `${env.PUBLIC_BASE_URL}/account`;
  const families = await sessionCancelledRecipients(env, session);
  const results = [];
  for (const f of families) {
    const reduced = Object.hasOwn(priceReductions, f.booking_id) ? priceReductions[f.booking_id] : 0;
    const message = sessionCancelled({
      parentName: f.parent_name, childName: f.child_name, className: session.class_name,
      startsAt: session.starts_at, reason: why, creditCents: f.credit_cents, accountUrl,
      priceReducedCents: reduced, amountNowCents: reduced > 0 ? f.amount_cents : null,
    });
    results.push(await sendTemplate(env, {
      template: 'session_cancelled', to: f.email, userId: f.user_id, bookingId: f.booking_id, sessionId,
      termId: f.term_id || session.term_id, dedupeKey: `session_cancelled:${sessionId}:${f.booking_id}`, ...message,
    }));
  }
  const { sent, skipped, failed } = tallySends(results);
  const creditCents = families.reduce((sum, f) => sum + f.credit_cents, 0);
  logEvent('session_cancelled_notified', {
    session_id: String(sessionId).slice(0, 8), families: families.length, sent, skipped, failed,
  });

  const summary = [
    `${session.class_name} on ${formatSydney(session.starts_at)} was cancelled${why ? ` (reason: ${why})` : ''}.`,
    families.length
      ? `Families emailed: ${sent + skipped} of ${families.length}.${failed ? ` ${failed} email(s) could not be sent — see the email log and contact those families yourself.` : ''}`
      : 'Nobody was booked into this class, so no families were emailed.',
    creditCents > 0
      ? `Credits given: ${formatAud(creditCents)} in total, used automatically on their next booking.`
      : 'No credits were given for this class.',
    Object.keys(priceReductions).length
      ? `Places not paid for yet now cost less: ${formatAud(Object.values(priceReductions).reduce((sum, c) => sum + c, 0))} taken off in total (${Object.keys(priceReductions).length} ${Object.keys(priceReductions).length === 1 ? 'family' : 'families'}).`
      : '',
    `Roster: ${env.PUBLIC_BASE_URL}/admin/sessions/${sessionId}/roster`,
  ];
  await notifyOwner(env, `Class cancelled — ${session.class_name}, ${formatSydney(session.starts_at, 'date')}`,
    summary.filter(Boolean).join('\n\n'),
    { dedupeKey: `session_cancelled:${sessionId}`, sessionId, termId: session.term_id, template: 'owner_session_cancelled' });

  return { families: families.length, sent, skipped, failed, creditCents };
}

// --- Failed instalment -------------------------------------------------------

// An instalment failed (invoice.payment_failed on a running plan). The family
// gets one email per failed invoice with an Update card link (Stripe retries
// the card by itself; overdueNudges in lib/jobs/ops.js reminds them weekly
// while the plan stays overdue). The owner is alerted on every attempt.
// Returns { parent: sendTemplate result | null, owner: [results] }.
export async function notifyPlanFailed(env, bookingId, { invoiceId = null, attempt = null, amountDueCents = null } = {}) {
  const booking = await loadBookingForNotification(env, bookingId);
  if (!booking) return { parent: null, owner: [] };
  const amount = Number.isInteger(amountDueCents) && amountDueCents > 0 ? amountDueCents : null;
  const failure = invoiceId ? String(invoiceId) : `attempt-${Number.isInteger(attempt) ? attempt : 0}`;

  const message = planFailed({
    parentName: booking.parent_name, childName: booking.child_name, amountDueCents: amount,
    updateCardUrl: `${env.PUBLIC_BASE_URL}/account`,
  });
  const parent = await sendTemplate(env, {
    template: 'plan_failed', to: booking.email, userId: booking.user_id, bookingId, termId: booking.term_id,
    dedupeKey: `plan_failed:${bookingId}:${failure}`, ...message,
  });
  logEvent('plan_failed_notified', {
    booking_id: String(bookingId).slice(0, 8), attempt,
    parent: parent.sent ? 'sent' : parent.skipped ? 'already_sent' : 'failed',
  });

  const familyLine = parent.sent
    ? "We've emailed the family a link to update their card."
    : parent.skipped
      ? 'The family was already emailed about this payment.'
      : "The email to the family couldn't be sent — please contact them yourself.";
  const owner = await notifyOwner(env, `Instalment failed — ${booking.child_name}`,
    [
      `An instalment${amount ? ` of ${formatAud(amount)}` : ''} for ${booking.child_name} (${booking.term_name || 'booking'}) failed to collect${attempt ? ` (attempt ${attempt})` : ''}. Stripe will retry automatically; the place is kept until you decide.`,
      familyLine,
      `${env.PUBLIC_BASE_URL}/admin/attention`,
    ].join('\n\n'),
    {
      dedupeKey: `plan_failed:${bookingId}:${invoiceId || 'unknown'}:${attempt || 0}`,
      bookingId, termId: booking.term_id, template: 'owner_plan_failed',
    });
  return { parent, owner };
}
