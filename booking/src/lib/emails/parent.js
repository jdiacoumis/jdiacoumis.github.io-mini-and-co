// Parent-facing email templates. Phase 2A owns this file (confirmation with
// the plan schedule, trial follow-up offer, …); Phase 1 provides the booking
// confirmation used by the payment webhook via lib/notify.js.
//
// Each builder returns { subject, text, html }; html is an auto-escaping
// html`` fragment. `booking` is the shape returned by
// domain.loadBookingForNotification().

import { html, joinHtml } from '../html.js';
import { formatSydney } from '../time.js';
import { formatAud, KIND_LABELS } from '../domain.js';
import { instalmentSchedule } from '../pricing.js';

function bookingTitle(booking) {
  const kind = KIND_LABELS[booking.kind] || 'Booking';
  if (!booking.term_name) return kind;
  return `${kind} — ${booking.term_name}${booking.class_name ? ` (${booking.class_name})` : ''}`;
}

function paymentLines(booking) {
  if (booking.payment_method === 'plan' && booking.plan_instalments) {
    const schedule = instalmentSchedule(
      booking.amount_cents, booking.plan_instalments, booking.plan_interval || 'week',
      booking.paid_at || booking.created_at,
    );
    const cadence = schedule.interval === 'fortnight' ? 'fortnightly' : 'weekly';
    return [
      `Payment plan: ${schedule.n} ${cadence} instalments, collected automatically from your card.`,
      ...schedule.payments.map((p) => `  ${p.index}. ${formatSydney(p.dueAt, 'date')} — ${formatAud(p.amountCents)}`),
    ];
  }
  if (booking.kind === 'complimentary') return ['This booking is complimentary — nothing to pay.'];
  if (booking.amount_cents === 0) {
    return [booking.credit_cents > 0
      ? `Covered by your account credit (${formatAud(booking.credit_cents)}) — nothing to pay.`
      : 'Nothing to pay.'];
  }
  return [`Paid: ${formatAud(booking.amount_cents)} AUD${booking.credit_cents > 0 ? ` (plus ${formatAud(booking.credit_cents)} account credit)` : ''}.`];
}

export function bookingConfirmationEmail({ booking, env }) {
  const greeting = `Hi${booking.parent_name ? ` ${booking.parent_name}` : ''},`;
  const sessions = booking.sessions.map(
    (s) => `${s.class_name} — ${formatSydney(s.starts_at)} (${s.duration_mins} min) at ${s.venue}`,
  );
  const payment = paymentLines(booking);
  const accountUrl = `${env.PUBLIC_BASE_URL}/account`;
  const subject = `Booking confirmed — see you soon, ${booking.child_name}!`;
  const text = [
    greeting,
    `Your booking for ${booking.child_name} is confirmed: ${bookingTitle(booking)}.`,
    sessions.map((s) => `  • ${s}`).join('\n'),
    payment.join('\n'),
    `You can see your bookings any time at ${accountUrl}`,
    "Can't make it? Reply to this email as early as you can and we'll do our best to help.",
    'Mini & Co. Sensory Classes',
  ].join('\n\n');
  const body = html`
    <p>${greeting}</p>
    <p>Your booking for <strong>${booking.child_name}</strong> is confirmed: ${bookingTitle(booking)}.</p>
    <ul>${joinHtml(sessions.map((s) => html`<li>${s}</li>`))}</ul>
    ${joinHtml(payment.map((line) => html`<p>${line}</p>`))}
    <p>You can see your bookings any time in <a href="${accountUrl}">your account</a>.</p>
    <p>Can't make it? Reply to this email as early as you can and we'll do our best to help.</p>
    <p>Mini &amp; Co. Sensory Classes</p>
  `;
  return { subject, text, html: body };
}
