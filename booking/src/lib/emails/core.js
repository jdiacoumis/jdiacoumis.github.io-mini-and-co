// Core email templates (Phase 1): owner alerts. Every builder returns
// { subject, text, html } where html is an auto-escaping html`` fragment —
// names and notes typed by families can never inject markup into an email.
//
// Phase 2 adds lib/emails/parent.js (parent-facing) and lib/emails/ops.js
// (reminders, notices, bulk email); this file stays small.

import { html, joinHtml } from '../html.js';
import { formatAud, NEEDS_ATTENTION_LABELS, KIND_LABELS } from '../domain.js';

const SIGN_OFF = 'Mini & Co. booking system';

function paragraphs(text) {
  return joinHtml(String(text).split(/\n{2,}/).map((p) => html`<p>${p}</p>`));
}

// A plain alert to the owner (ADMIN_EMAILS).
export function ownerAlertEmail({ subject, text }) {
  return {
    subject: `[Mini & Co. bookings] ${subject}`,
    text: `${text}\n\n${SIGN_OFF}`,
    html: html`${paragraphs(text)}<p>${SIGN_OFF}</p>`,
  };
}

// "A booking needs your attention" — paid with no seat, paid after
// cancellation, payment mismatch, plan ended short …
export function attentionEmail({ booking, flag, env, detail = '' }) {
  const label = NEEDS_ATTENTION_LABELS[flag] || flag;
  const what = [KIND_LABELS[booking.kind] || booking.kind, booking.term_name, booking.class_name]
    .filter(Boolean).join(' — ');
  const link = `${env.PUBLIC_BASE_URL}/admin/attention`;
  const lines = [
    `A booking needs your attention: ${label}.`,
    `Child: ${booking.child_name}. Parent: ${booking.parent_name || '(no name)'} <${booking.email}>.`,
    `Booking: ${what}. Owed ${formatAud(booking.amount_cents)}, received ${formatAud(booking.paid_cents)}.`,
    detail,
    `Open the admin to sort it out: ${link}`,
  ].filter(Boolean);
  return {
    subject: `[Mini & Co. bookings] Needs attention — ${label}`,
    text: `${lines.join('\n\n')}\n\n${SIGN_OFF}`,
    html: html`${joinHtml(lines.slice(0, -1).map((l) => html`<p>${l}</p>`))}
      <p><a href="${link}">Open the Needs attention list</a></p><p>${SIGN_OFF}</p>`,
  };
}
