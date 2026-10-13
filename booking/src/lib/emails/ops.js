// Operational email templates: reminders, cancellations, re-enrolment,
// waitlist offers, failed instalments, offline receipts, bulk mail. Phase 2C
// owns this file; the function names and argument shapes below are the
// contract other modules (Phase 2B admin routes, lib/notify.js, the cron
// jobs) import. Optional fields may be added; existing ones never change.
//
// Every builder takes a plain object and returns { subject, text, html }.
//   * `html` is an auto-escaping html`` fragment: a child called "<b>Max</b>"
//     arrives as text, never as markup. Never interpolate raw strings.
//   * `text` is the plain-text alternative with the same content.
//   * `subject` is plain text on one line (line breaks would break headers).
// Amounts are AUD cents (formatAud); instants are UTC ISO strings rendered in
// Australia/Sydney (formatSydney).

import { html, joinHtml } from '../html.js';
import { formatSydney } from '../time.js';
import { formatAud } from '../domain.js';

export const SIGN_OFF_LINES = ['Warmly,', 'Camila — Mini & Co. Sensory Classes'];

// A message is a list of blocks:
//   'a paragraph'                       (line breaks inside are kept)
//   { lead, href, label }               a paragraph ending in a link
//   { items: ['…', '…'] }               a bulleted list
// Falsy blocks are dropped, so optional lines can be written inline.
function blockText(block) {
  if (typeof block === 'string') return block;
  if (block.href) return block.lead ? `${block.lead} ${block.href}` : block.href;
  if (block.items) return block.items.map((item) => `  • ${item}`).join('\n');
  return '';
}

function lines(text) {
  return joinHtml(String(text).split('\n').map((line) => html`${line}`), '<br>');
}

function blockHtml(block) {
  if (typeof block === 'string') return html`<p>${lines(block)}</p>`;
  if (block.href) {
    return html`<p>${block.lead ? html`${block.lead} ` : ''}<a href="${block.href}">${block.label || block.href}</a></p>`;
  }
  if (block.items) return html`<ul>${joinHtml(block.items.map((item) => html`<li>${item}</li>`))}</ul>`;
  return html``;
}

// One line, no control characters, bounded (email_log keeps 200 characters).
export function cleanSubject(subject) {
  return String(subject ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 200);
}

function build(subject, blocks) {
  const kept = blocks.filter(Boolean);
  return {
    subject: cleanSubject(subject),
    text: `${kept.map(blockText).join('\n\n')}\n\n${SIGN_OFF_LINES.join('\n')}`,
    html: html`${joinHtml(kept.map(blockHtml))}<p>${lines(SIGN_OFF_LINES.join('\n'))}</p>`,
  };
}

function greeting(parentName) {
  const name = String(parentName || '').trim();
  return `Hi ${name || 'there'},`;
}

function possessive(name) {
  const n = String(name || '').trim() || 'your little one';
  return /s$/i.test(n) ? `${n}'` : `${n}'s`;
}

function accountLink(accountUrl, label = 'Open my account') {
  return accountUrl ? { lead: 'You can see your bookings any time in your account:', href: accountUrl, label } : null;
}

// The day-before reminder (sent by sendReminders in lib/jobs/ops.js for
// sessions starting 20–28 hours ahead).
export function reminder({ parentName, childName, className, startsAt, venue, accountUrl = '' }) {
  return build(`Reminder: ${possessive(childName)} class on ${formatSydney(startsAt, 'date')}`, [
    greeting(parentName),
    `Just a reminder that ${possessive(childName)} class is coming up:`,
    { items: [className, formatSydney(startsAt), venue].filter(Boolean) },
    'All you need to bring is comfortable clothes you can sit on the floor in, a water bottle if you\'d like one, '
      + `and a muslin or burp cloth for ${childName || 'your little one'}.`,
    "If you can't make it, please reply to this email to let us know.",
    accountLink(accountUrl),
  ]);
}

// The owner cancelled a session; creditCents is the credit issued for this
// child (0 when none was issued).
export function sessionCancelled({
  parentName, childName, className, startsAt, reason = '', creditCents = 0, accountUrl = '',
}) {
  const why = String(reason || '').trim();
  return build(`Class cancelled: ${className}, ${formatSydney(startsAt, 'date')}`, [
    greeting(parentName),
    `We're sorry to let you know that ${className} on ${formatSydney(startsAt)} has been cancelled${why ? ` (${why})` : ''}.`,
    creditCents > 0
      ? `We've added a credit of ${formatAud(creditCents)} to your account for ${childName}. `
        + "It's used automatically the next time you book."
      : `If you have any questions about ${possessive(childName)} booking, just reply to this email.`,
    accountUrl ? { lead: 'Your bookings and credit:', href: accountUrl, label: 'Open my account' } : null,
  ]);
}

// Auto-enrol invitation (Phase 2B's re-run): a held seat in the next term,
// pay by payByAt. `returning` (optional) says amountCents is the
// returning-family price.
export function reenrolInvitation({
  parentName, childName, termName, className, amountCents, payByAt, accountUrl = '', returning = false,
}) {
  return build(`${possessive(childName)} place in ${termName} is saved — pay by ${formatSydney(payByAt, 'date')}`, [
    greeting(parentName),
    `We'd love to have ${childName} back! We've saved a place for them in ${termName} (${className}).`,
    `To keep it, sign in and press Pay now before ${formatSydney(payByAt)}. `
      + `${returning ? 'Your returning-family price is' : 'The price for the term is'} ${formatAud(amountCents)}.`,
    'After that, the place opens up to new families.',
    accountUrl ? { lead: 'Sign in here:', href: accountUrl, label: 'Go to my account' } : null,
  ]);
}

// Waitlist offer: a seat is held until expiresAt. `detail` says what is on
// offer ("the rest of the term — 4 weeks, …").
export function waitlistOffer({
  parentName, childName, termName, className, amountCents, expiresAt, accountUrl = '', detail = '',
}) {
  const owed = Number(amountCents) || 0;
  return build(`A place has opened up for ${childName} — ${termName}`, [
    greeting(parentName),
    `Good news — a place has opened up for ${childName} in ${termName} (${className})${detail ? `: ${detail}` : ''}.`,
    owed > 0
      ? `We're holding it for you until ${formatSydney(expiresAt)}. To take it, sign in to your account and press Pay now (${formatAud(owed)}).`
      : `We're holding it for you until ${formatSydney(expiresAt)}. There's nothing to pay — sign in to your account and press Pay now to accept it.`,
    "If we haven't heard from you by then, we'll offer the place to the next family on the waitlist. "
      + 'If you no longer need it, just reply to let us know.',
    accountUrl ? { lead: 'Sign in here:', href: accountUrl, label: 'Go to my account' } : null,
  ]);
}

// An instalment failed (`nudge: true` — the weekly reminder while the plan is
// still overdue). updateCardUrl is the account page, whose Update card button
// opens Stripe's billing portal.
export function planFailed({ parentName, childName, amountDueCents, updateCardUrl = '', nudge = false }) {
  const amount = Number.isInteger(amountDueCents) && amountDueCents > 0 ? ` (${formatAud(amountDueCents)})` : '';
  const subject = nudge
    ? `Reminder: a payment for ${possessive(childName)} classes is still outstanding`
    : `Payment didn't go through — ${possessive(childName)} classes`;
  return build(subject, [
    greeting(parentName),
    nudge
      ? `Just a reminder that an instalment for ${possessive(childName)} classes${amount} is still outstanding.`
      : `The latest instalment for ${possessive(childName)} classes${amount} didn't go through.`,
    nudge
      ? `${possessive(childName)} place is still safe. Please update your card from your account so the payment can go through, or reply to this email if you'd like to pay another way.`
      : `${possessive(childName)} place is safe — the card will be tried again automatically over the next few days. If your card has changed or expired, please update it from your account.`,
    updateCardUrl ? { lead: 'Update your card:', href: updateCardUrl, label: 'Go to my account' } : null,
    'Any questions? Just reply to this email.',
  ]);
}

const RECEIPT_METHODS = { cash: 'in cash', 'bank transfer': 'by bank transfer', 'card (in person)': 'by card' };

// Receipt for a payment the owner recorded by hand (cash, bank transfer).
export function offlineReceipt({
  parentName, childName, amountCents, method = 'payment', paidAt, summary = '', accountUrl = '',
}) {
  const how = RECEIPT_METHODS[String(method || '').toLowerCase()] || '';
  return build(`Receipt: ${formatAud(amountCents)} received — thank you`, [
    greeting(parentName),
    `Thank you — we've received ${formatAud(amountCents)}${how ? ` ${how}` : ''} on ${formatSydney(paidAt, 'date')} `
      + `for ${possessive(childName)} classes${summary ? ` (${summary})` : ''}.`,
    accountLink(accountUrl, 'See my bookings'),
  ]);
}

// Owner-composed bulk email. bodyText is the owner's plain text: paragraphs
// split on blank lines, single line breaks kept. Greeting and sign-off are
// added here, so the owner writes only the message itself.
export function bulk({ subject, bodyText, parentName }) {
  const paragraphs = String(bodyText || '').replace(/\r\n?/g, '\n').split(/\n{2,}/)
    .map((p) => p.trim()).filter(Boolean);
  return build(subject || 'A note from Mini & Co.', [greeting(parentName), ...paragraphs]);
}
