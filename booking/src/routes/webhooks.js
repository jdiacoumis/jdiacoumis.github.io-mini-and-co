// Stripe webhook: the ONLY path that marks a real payment as confirmed.
//
// Security:
//   * Signature verification (HMAC-SHA256 over `${t}.${payload}`, constant
//     time, 5-minute tolerance) happens before the payload is trusted at all;
//     failures return 400 and change nothing.
//   * Replay protection: event ids are recorded in webhook_events; an id seen
//     before is acknowledged without reprocessing (idempotent).
//   * The booking id comes from client_reference_id, set server-side when the
//     checkout session was created — nothing client-controlled decides which
//     booking gets confirmed.
//   * Email and Conversions API failures never fail the webhook (Stripe would
//     retry and double-process); they are logged and the 200 still goes out.

import { getPaymentsDriver } from '../lib/payments-driver.js';
import { sendEmail } from '../lib/email-driver.js';
import { sendPurchaseEvent, markCapiSent } from '../lib/capi-driver.js';
import { confirmBooking, expireBooking, loadBookingForNotification, formatAud } from '../lib/domain.js';
import { formatSydney } from '../lib/time.js';
import { nowIso } from '../lib/db.js';
import { logEvent, logError, maskEmail } from '../lib/log.js';

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

function json(status, body) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

// Record an event id; returns false ONLY for a genuine replay (primary-key
// conflict). Any other database failure propagates so the webhook returns a
// 5xx and Stripe retries — a transient error must never be acknowledged as
// processed.
async function recordWebhookEvent(env, eventId) {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO webhook_events (event_id, received_at) VALUES (?1, ?2)`,
  ).bind(eventId, nowIso()).run();
  return result.meta.changes > 0;
}

// Send the booking confirmation email. Failure is logged, never thrown.
export async function sendBookingConfirmationEmail(env, bookingId) {
  const booking = await loadBookingForNotification(env, bookingId);
  if (!booking) return;

  const sessionLines = booking.sessions.map(
    (s) => `  • ${s.class_name} — ${formatSydney(s.starts_at)} (${s.duration_mins} min) at ${s.venue}`,
  ).join('\n');
  const sessionHtml = booking.sessions.map(
    (s) => `<li>${s.class_name} — ${formatSydney(s.starts_at)} (${s.duration_mins} min) at ${s.venue}</li>`,
  ).join('');

  const subject = `Booking confirmed — see you soon, ${booking.child_name}!`;
  const bodyText = `Hi${booking.parent_name ? ` ${booking.parent_name}` : ''},\n\n`
    + `Your booking for ${booking.child_name} is confirmed and paid (${formatAud(booking.amount_cents)} AUD).\n\n`
    + `${sessionLines}\n\n`
    + `You can see your bookings any time at ${env.PUBLIC_BASE_URL}/account\n\n`
    + `Can't make it? Reply to this email as early as you can and we'll do our best to move you to another session.\n\n`
    + `Mini & Co. Sensory Classes`;
  const bodyHtml = `<p>Hi${booking.parent_name ? ` ${booking.parent_name}` : ''},</p>`
    + `<p>Your booking for <strong>${booking.child_name}</strong> is confirmed and paid (<strong>${formatAud(booking.amount_cents)} AUD</strong>).</p>`
    + `<ul>${sessionHtml}</ul>`
    + `<p>You can see your bookings any time in <a href="${env.PUBLIC_BASE_URL}/account">your account</a>.</p>`
    + `<p>Can't make it? Reply to this email as early as you can and we'll do our best to move you to another session.</p>`
    + `<p>Mini &amp; Co. Sensory Classes</p>`;

  try {
    await sendEmail(env, booking.email, subject, bodyText, bodyHtml);
  } catch (err) {
    logError('confirmation_email_failed', err, { booking_id: bookingId.slice(0, 8) });
  }
}

// Fire the server-side Conversions API Purchase exactly once per booking,
// with event_id = booking id so Meta dedupes against the browser pixel.
// No-op when no CAPI token is configured; failures never propagate.
async function sendCapiPurchaseOnce(env, bookingId) {
  const booking = await loadBookingForNotification(env, bookingId);
  if (!booking || booking.capi_sent) return;

  const result = await sendPurchaseEvent(env, {
    bookingId: booking.id,
    email: booking.email,
    phone: booking.phone,
    amountCents: booking.amount_cents,
  });
  if (result.sent) await markCapiSent(env, bookingId);
}

// Shared by the real webhook and the dev mock checkout (design D5): process a
// checkout lifecycle event against the booking it references.
export async function processCheckoutEvent(env, event) {
  const type = event?.type;
  const session = event?.data?.object;
  const bookingId = session?.client_reference_id;

  if (!bookingId || typeof bookingId !== 'string') {
    logEvent('webhook_no_booking_ref', { event_type: String(type || 'unknown') });
    return { handled: false };
  }

  if (type === 'checkout.session.completed') {
    const result = await confirmBooking(env, bookingId, {
      paymentProvider: env.PAYMENTS_DRIVER,
      paymentRef: typeof session.id === 'string' ? session.id : null,
      paymentIntent: typeof session.payment_intent === 'string' ? session.payment_intent : null,
      amountCents: Number.isInteger(session.amount_total) ? session.amount_total : null,
    });

    if (result.error) {
      logEvent('webhook_confirm_rejected', { booking_id: bookingId.slice(0, 8), reason: result.error });
      return { handled: true };
    }
    if (!result.alreadyConfirmed) {
      await sendBookingConfirmationEmail(env, bookingId);
      await sendCapiPurchaseOnce(env, bookingId);
    }
    return { handled: true };
  }

  if (type === 'checkout.session.expired') {
    await expireBooking(env, bookingId);
    logEvent('webhook_checkout_expired', { booking_id: bookingId.slice(0, 8) });
    return { handled: true };
  }

  logEvent('webhook_ignored_event', { event_type: String(type || 'unknown') });
  return { handled: false };
}

// POST /api/stripe/webhook
export async function handleStripeWebhook(req, env) {
  const length = Number(req.headers.get('Content-Length') || 0);
  if (length > MAX_WEBHOOK_BODY_BYTES) {
    return json(413, { error: 'payload_too_large' });
  }

  const body = await req.text();
  if (body.length > MAX_WEBHOOK_BODY_BYTES) {
    return json(413, { error: 'payload_too_large' });
  }

  const driver = getPaymentsDriver(env);
  let event;
  try {
    event = await driver.verifyWebhook(req.headers.get('Stripe-Signature'), body);
  } catch (err) {
    // Unsigned, tampered, or stale: reject without touching any booking.
    logEvent('webhook_signature_rejected', { reason: err.message });
    return json(400, { error: 'invalid_signature' });
  }

  if (!event || typeof event.id !== 'string' || event.id.length > 200) {
    return json(400, { error: 'invalid_event' });
  }

  if (!(await recordWebhookEvent(env, event.id))) {
    logEvent('webhook_replay_ignored', { event_id: event.id.slice(0, 12) });
    return json(200, { received: true, replay: true });
  }

  await processCheckoutEvent(env, event);
  return json(200, { received: true });
}
