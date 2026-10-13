// Notifications (design D10): every email the system sends goes through
// sendTemplate(), which writes email_log. A dedupe key makes a send
// idempotent — scheduled jobs and webhook retries can run again safely and a
// family never gets the same email twice. A failed send is logged as 'failed'
// and may be retried by the next run.
//
// notifySessionCancelled() and notifyPlanFailed() are Phase 1 stubs that log
// and alert the owner; Phase 2C replaces their bodies (parent emails with the
// credit note / an Update card link) without changing their signatures.

import { sendEmail } from './email-driver.js';
import { uuid, nowIso } from './db.js';
import { logEvent, logError } from './log.js';
import { normaliseEmail, isValidEmail, emailAllowlist } from './validate.js';
import { loadBookingForNotification } from './domain.js';
import { ownerAlertEmail, attentionEmail } from './emails/core.js';
import { bookingConfirmationEmail } from './emails/parent.js';

// Send one templated email and log it.
//   template: short name for the log ('booking_confirmed', 'reminder', …)
//   dedupeKey: e.g. 'reminder:<session>:<booking>' — a second call with the
//              same key is skipped (unless the first attempt failed)
// Returns { sent: true, id } | { skipped: true } | { sent: false, error }.
// Never throws for delivery problems (callers are jobs and webhooks).
export async function sendTemplate(env, {
  template, to, userId = null, bookingId = null, sessionId = null, termId = null,
  dedupeKey = null, subject, text, html: htmlBody = '',
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
    const providerRef = await sendEmail(env, email, subject, text, String(htmlBody || ''));
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

// STUB (Phase 2C replaces the body): the owner cancelled a session; families
// get a notice with their credit.
export async function notifySessionCancelled(env, sessionId, { reason = '' } = {}) {
  logEvent('session_cancelled_notice_stub', { session_id: String(sessionId).slice(0, 8) });
  return notifyOwner(env, 'A class was cancelled',
    `A class session was cancelled${reason ? ` (reason: ${reason})` : ''}. Family notices are not automated yet — please contact the families on the roster.\n\n${env.PUBLIC_BASE_URL}/admin/sessions/${sessionId}/roster`,
    { dedupeKey: `session_cancelled:${sessionId}`, sessionId });
}

// STUB (Phase 2C replaces the body): an instalment failed; the family gets an
// Update card link. `invoiceId`/`attempt` identify the failure for dedupe.
export async function notifyPlanFailed(env, bookingId, { invoiceId = null, attempt = null, amountDueCents = null } = {}) {
  logEvent('plan_failed_notice_stub', { booking_id: String(bookingId).slice(0, 8), attempt });
  const booking = await loadBookingForNotification(env, bookingId);
  if (!booking) return [];
  const amount = Number.isInteger(amountDueCents) ? ` of $${(amountDueCents / 100).toFixed(2)}` : '';
  return notifyOwner(env, `Instalment failed — ${booking.child_name}`,
    `An instalment${amount} for ${booking.child_name} (${booking.term_name || 'booking'}) failed to collect${attempt ? ` (attempt ${attempt})` : ''}. Stripe will retry automatically; the place is kept until you decide.\n\n${env.PUBLIC_BASE_URL}/admin/attention`,
    {
      dedupeKey: `plan_failed:${bookingId}:${invoiceId || 'unknown'}:${attempt || 0}`,
      bookingId, termId: booking.term_id, template: 'owner_plan_failed',
    });
}

