// Parent-facing email templates (Phase 2A — parent-comms spec): the booking
// confirmation (with the instalment schedule when a plan was chosen) and the
// trial follow-up offer of the rest of the term. Sent through
// lib/notify.js sendTemplate(), which logs every send with a dedupe key.
//
// Each builder returns { subject, text, html }; html is an auto-escaping
// html`` fragment, so names typed by families can never inject markup.
// `booking` is the shape returned by domain.loadBookingForNotification().

import { html, joinHtml } from '../html.js';
import { formatSydney } from '../time.js';
import { formatAud, KIND_LABELS } from '../domain.js';
import { instalmentSchedule } from '../pricing.js';

const SIGN_OFF = ['Warmly,', 'Camila — Mini & Co. Sensory Classes'];

function greeting(parentName) {
  return `Hi ${parentName || 'there'},`;
}

function weeksText(n) {
  return `${n} ${n === 1 ? 'week' : 'weeks'}`;
}

function bookingTitle(booking) {
  const count = (booking.sessions || []).length;
  const kind = booking.kind === 'casual'
    ? (count === 1 ? 'Casual class' : 'Casual classes')
    : KIND_LABELS[booking.kind] || 'Booking';
  if (!booking.term_name) return kind;
  return `${kind} — ${booking.term_name}${booking.class_name ? ` (${booking.class_name})` : ''}`;
}

// The money part of the confirmation: { lines (plain text), schedule
// ([{ label, amount }] for a plan, else []), after (lines after the schedule) }.
function paymentParts(booking) {
  if (booking.kind === 'complimentary' || booking.payment_status === 'waived') {
    return { lines: ['This booking is complimentary — nothing to pay.'], schedule: [], after: [] };
  }
  const extras = [];
  if (booking.discount_cents > 0) {
    extras.push(`${booking.voucher_code ? `Voucher ${booking.voucher_code}` : 'Discount'}: −${formatAud(booking.discount_cents)}`);
  }
  if (booking.credit_cents > 0) extras.push(`Account credit used: ${formatAud(booking.credit_cents)}`);

  if (booking.payment_method === 'plan' && booking.plan_instalments && booking.amount_cents > 0) {
    const schedule = instalmentSchedule(
      booking.amount_cents, booking.plan_instalments, booking.plan_interval || 'week',
      booking.paid_at || booking.created_at,
    );
    const cadence = schedule.interval === 'fortnight' ? 'fortnightly' : 'weekly';
    return {
      lines: [`Payment plan: ${schedule.n} ${cadence} instalments, collected automatically from your card.`],
      schedule: schedule.payments.map((p) => ({
        label: `${p.index}. ${formatSydney(p.dueAt, 'date')}`,
        amount: `${formatAud(p.amountCents)}${p.index === 1 ? ' (charged at checkout)' : ''}`,
      })),
      after: [
        ...extras,
        "If an instalment doesn't go through we'll let you know — your place is kept, and you can update your card from your account.",
      ],
    };
  }
  if (booking.amount_cents === 0) {
    return {
      lines: [
        booking.credit_cents > 0
          ? `Covered by your account credit (${formatAud(booking.credit_cents)}) — nothing to pay.`
          : 'Nothing to pay.',
        ...(booking.discount_cents > 0 ? extras.slice(0, 1) : []),
      ],
      schedule: [],
      after: [],
    };
  }
  const first = booking.payment_status === 'paid'
    ? `Paid: ${formatAud(booking.amount_cents)} AUD.`
    : `Total: ${formatAud(booking.amount_cents)} AUD.`;
  return { lines: [first, ...extras], schedule: [], after: [] };
}

export function bookingConfirmationEmail({ booking, env }) {
  const accountUrl = `${env.PUBLIC_BASE_URL}/account`;
  const sessions = (booking.sessions || []).map((s) => `${formatSydney(s.starts_at)} (${s.duration_mins} min)`);
  const venues = [...new Set((booking.sessions || []).map((s) => s.venue).filter(Boolean))];
  const pay = paymentParts(booking);
  const subject = `Booking confirmed — see you soon, ${booking.child_name}!`;
  const intro = `${booking.child_name}'s booking is confirmed: ${bookingTitle(booking)}.`;
  const classesHeading = sessions.length === 1 ? 'Your class:' : `Your classes (${sessions.length}):`;
  const where = venues.length ? `Where: ${venues.join('; ')}` : '';
  const trial = booking.kind === 'trial'
    ? "After the class we'll email you an offer to join the rest of the term — we'd love to have you."
    : '';
  const outro = [
    `You can see your bookings any time at ${accountUrl}`,
    "Can't make it? Reply to this email as early as you can — with at least 48 hours' notice we can usually offer a credit or another class.",
  ];

  const text = [
    greeting(booking.parent_name),
    intro,
    [classesHeading, ...sessions.map((s) => `  • ${s}`)].join('\n'),
    where,
    [...pay.lines, ...pay.schedule.map((p) => `  ${p.label} — ${p.amount}`)].join('\n'),
    pay.after.join('\n'),
    trial,
    ...outro,
    SIGN_OFF.join('\n'),
  ].filter(Boolean).join('\n\n');

  const body = html`
    <p>${greeting(booking.parent_name)}</p>
    <p>${booking.child_name}'s booking is confirmed: <strong>${bookingTitle(booking)}</strong>.</p>
    <p>${classesHeading}</p>
    <ul>${joinHtml(sessions.map((s) => html`<li>${s}</li>`))}</ul>
    ${where ? html`<p>${where}</p>` : ''}
    ${joinHtml(pay.lines.map((line) => html`<p>${line}</p>`))}
    ${pay.schedule.length ? html`<ol>${joinHtml(pay.schedule.map((p) => html`<li>${p.label.replace(/^\d+\.\s*/, '')} — ${p.amount}</li>`))}</ol>` : ''}
    ${joinHtml(pay.after.map((line) => html`<p>${line}</p>`))}
    ${trial ? html`<p>${trial}</p>` : ''}
    <p>You can see your bookings any time in <a href="${accountUrl}">your account</a>.</p>
    <p>${outro[1]}</p>
    <p>${SIGN_OFF[0]}<br>${SIGN_OFF[1]}</p>
  `;
  return { subject, text, html: body };
}

// The day after a trial class: an offer of the rest of the term at the
// pro-rata price (or its waitlist when the term is full).
//   offer: { weeks, listCents, amountCents, creditCents, plan: { n, interval,
//            eachCents, firstCents } | null, nextStartsAt, isFull }
export function trialFollowUpEmail({
  parentName, childName, className, termName, offer, bookUrl, waitlistUrl, classesUrl,
}) {
  const subject = `How was ${childName}'s trial class? Join the rest of ${termName}`;
  const thanks = `Thank you for coming along to ${className} — we hope ${childName} enjoyed it!`;
  const lines = [];
  let cta = null;
  if (offer.isFull) {
    lines.push(`${termName} is full at the moment, but you can join the waitlist and we'll let you know as soon as a place opens up.`);
    cta = { label: 'Join the waitlist', url: waitlistUrl };
  } else {
    const rest = offer.weeks === 1 ? `the final week of ${termName}` : `the remaining ${weeksText(offer.weeks)} of ${termName}`;
    lines.push(`If you'd like to keep coming, ${childName} can join ${rest} for ${formatAud(offer.listCents)} — the term price for just the weeks that are left.`);
    if (offer.creditCents > 0) {
      lines.push(`Your account credit of ${formatAud(offer.creditCents)} comes off automatically, so you'd pay ${formatAud(offer.amountCents)}.`);
    }
    if (offer.plan) {
      const cadence = offer.plan.interval === 'fortnight' ? 'fortnightly' : 'weekly';
      lines.push(`You can pay in full, or in ${offer.plan.n} ${cadence} instalments (${formatAud(offer.plan.firstCents)} when you book, then ${formatAud(offer.plan.eachCents)}).`);
    }
    if (offer.nextStartsAt) lines.push(`The next class is ${formatSydney(offer.nextStartsAt)}.`);
    lines.push("Places are limited and go in the order they're booked.");
    cta = { label: offer.weeks === 1 ? 'Book the final week' : `Book the remaining ${weeksText(offer.weeks)}`, url: bookUrl };
  }

  const text = [
    greeting(parentName),
    thanks,
    ...lines,
    `${cta.label}: ${cta.url}`,
    `See all our classes: ${classesUrl}`,
    SIGN_OFF.join('\n'),
  ].join('\n\n');
  const body = html`
    <p>${greeting(parentName)}</p>
    <p>${thanks}</p>
    ${joinHtml(lines.map((line) => html`<p>${line}</p>`))}
    <p><a href="${cta.url}"><strong>${cta.label}</strong></a></p>
    <p>Or <a href="${classesUrl}">see all our classes</a>.</p>
    <p>${SIGN_OFF[0]}<br>${SIGN_OFF[1]}</p>
  `;
  return { subject, text, html: body };
}
