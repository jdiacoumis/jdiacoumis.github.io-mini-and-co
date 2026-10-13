// Operational email templates: reminders, cancellations, re-enrolment,
// waitlist offers, failed instalments, offline receipts, bulk mail. Phase 2C
// owns this file and refines the wording; the function names and argument
// shapes below are the contract other modules (Phase 2B admin routes) import.
//
// Every builder takes a plain object and returns { subject, text, html }.
// `html` is an auto-escaping html`` fragment; never interpolate raw strings.
// Amounts are AUD cents; instants are UTC ISO strings rendered via formatSydney.

import { html, joinHtml } from '../html.js';
import { formatSydney } from '../time.js';
import { formatAud } from '../domain.js';

const SIGN_OFF = 'Warmly,\nCamila — Mini & Co. Sensory Classes';

function para(lines) {
  return joinHtml(lines.map((line) => html`<p>${line}</p>`));
}

function greeting(parentName) {
  return `Hi ${parentName || 'there'},`;
}

function build(subject, lines) {
  return {
    subject,
    text: `${lines.join('\n\n')}\n\n${SIGN_OFF}`,
    html: html`${para(lines)}<p>${SIGN_OFF}</p>`,
  };
}

// The day-before reminder (sent by the cron job in lib/jobs/ops.js).
export function reminder({ parentName, childName, className, startsAt, venue }) {
  return build(`Reminder: ${className} ${formatSydney(startsAt, 'date')}`, [
    greeting(parentName),
    `A quick reminder that ${childName}'s class is coming up: ${className}, ${formatSydney(startsAt)}${venue ? ` at ${venue}` : ''}.`,
    'Bring socks for you both and a muslin or small towel. See you there!',
  ]);
}

// The owner cancelled a session; creditCents is 0 when no credit was issued.
export function sessionCancelled({ parentName, childName, className, startsAt, reason = '', creditCents = 0, accountUrl = '' }) {
  return build(`Class cancelled: ${className} ${formatSydney(startsAt, 'date')}`, [
    greeting(parentName),
    `We're sorry — ${className} on ${formatSydney(startsAt)} has been cancelled${reason ? ` (${reason})` : ''}.`,
    creditCents > 0
      ? `A credit of ${formatAud(creditCents)} has been added to your account for ${childName} and will be applied automatically to your next booking.`
      : 'No payment was taken for this class.',
    accountUrl ? `You can see your bookings and credits at ${accountUrl}.` : '',
  ].filter(Boolean));
}

// Auto-enrol invitation: a held seat in the next term, pay by payByAt.
export function reenrolInvitation({ parentName, childName, termName, className, amountCents, payByAt, accountUrl = '' }) {
  return build(`${childName}'s place in ${termName} is saved — pay by ${formatSydney(payByAt, 'date')}`, [
    greeting(parentName),
    `We've saved ${childName}'s place in ${termName} (${className}).`,
    `To keep it, sign in and press Pay now before ${formatSydney(payByAt)} — the price for returning families is ${formatAud(amountCents)}. After that the place opens to everyone.`,
    accountUrl ? `Sign in here: ${accountUrl}` : '',
  ].filter(Boolean));
}

// Waitlist offer: a seat is held until expiresAt.
export function waitlistOffer({ parentName, childName, termName, className, amountCents, expiresAt, accountUrl = '', detail = '' }) {
  return build(`A place has opened for ${childName} — ${termName}`, [
    greeting(parentName),
    `Good news — a place has opened up for ${childName} in ${termName} (${className})${detail ? `: ${detail}` : ''}.`,
    `It's held for you until ${formatSydney(expiresAt)}. Sign in and press Pay now (${formatAud(amountCents)}) to take it; after that it goes to the next family on the list.`,
    accountUrl ? `Sign in here: ${accountUrl}` : '',
  ].filter(Boolean));
}

// An instalment failed; updateCardUrl is the account page (or billing portal).
export function planFailed({ parentName, childName, amountDueCents, updateCardUrl = '' }) {
  return build(`Payment didn't go through — ${childName}'s classes`, [
    greeting(parentName),
    `The latest instalment for ${childName}'s classes${Number.isInteger(amountDueCents) ? ` (${formatAud(amountDueCents)})` : ''} didn't go through.`,
    'Your place is safe — the payment will be retried automatically. If your card has changed, please update it here:',
    updateCardUrl,
  ].filter(Boolean));
}

// Receipt for a payment the owner recorded by hand (cash, bank transfer).
export function offlineReceipt({ parentName, childName, amountCents, method = 'payment', paidAt, summary = '', accountUrl = '' }) {
  return build(`Receipt: ${formatAud(amountCents)} received`, [
    greeting(parentName),
    `Thanks — we've recorded your ${method} of ${formatAud(amountCents)} on ${formatSydney(paidAt, 'date')} for ${childName}${summary ? ` (${summary})` : ''}.`,
    accountUrl ? `Your bookings: ${accountUrl}` : '',
  ].filter(Boolean));
}

// Owner-composed bulk email: body is plain text; paragraphs split on blank lines.
export function bulk({ subject, bodyText, parentName }) {
  const paragraphs = String(bodyText || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return build(subject || 'A note from Mini & Co.', [greeting(parentName), ...paragraphs]);
}
