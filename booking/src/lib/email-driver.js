// Email driver: Resend (production) or a console outbox (local development).
//
// Fail-closed: an unknown EMAIL_DRIVER throws (it never silently falls back to
// the console outbox), and the console driver refuses to load outside
// ENVIRONMENT=development — so a misconfigured deploy fails loudly instead of
// "sending" magic links into a table nobody reads.
//
// Replies: mail is sent from EMAIL_FROM (bookings@…, which need not receive
// mail), and every email carries a Reply-To — EMAIL_REPLY_TO, else the first
// ADMIN_EMAILS address — so a family who "replies to this email" (the
// confirmation, reminder, class-cancelled, waitlist-offer, failed-payment and
// pay-later emails all invite it) reaches the owner.
//
// Logging is PII-safe: masked recipient and provider only — never the body
// (magic links carry sign-in tokens) or the subject (subjects can carry a
// child's name).

import { logEvent, logError, maskEmail } from './log.js';
import { nowIso } from './db.js';
import { escapeHtml } from './html.js';
import { normaliseEmail, isValidEmail, emailAllowlist } from './validate.js';

// Where replies to the system's emails go: EMAIL_REPLY_TO, else the first
// ADMIN_EMAILS address; null when neither is a valid address (replies then go
// to EMAIL_FROM).
export function defaultReplyTo(env) {
  const configured = normaliseEmail(env.EMAIL_REPLY_TO);
  if (isValidEmail(configured)) return configured;
  return emailAllowlist(env.ADMIN_EMAILS).find((address) => isValidEmail(address)) || null;
}

async function resendDriver(env, { to, subject, bodyText, bodyHtml, replyTo }) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
  const payload = { from: env.EMAIL_FROM, to, subject, text: bodyText, html: bodyHtml };
  if (replyTo) payload.reply_to = replyTo;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    // Security: the error body can echo the recipient — status only.
    throw new Error(`Resend failed (HTTP ${response.status})`);
  }
  const data = await response.json();
  logEvent('email_sent', { to: maskEmail(to), provider: 'resend' });
  return data.id || null;
}

// Development outbox: the dev_emails table, readable at /dev/mailbox.
async function consoleDriver(env, { to, subject, bodyText, bodyHtml, replyTo }) {
  const result = await env.DB.prepare(
    `INSERT INTO dev_emails (to_email, subject, body_text, body_html, reply_to, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(to, subject, bodyText, bodyHtml, replyTo || '', nowIso()).run();
  logEvent('email_sent', { to: maskEmail(to), provider: 'console' });
  return `dev-${result.meta.last_row_id}`;
}

function pickDriver(env) {
  if (env.EMAIL_DRIVER === 'resend') return resendDriver;
  if (env.EMAIL_DRIVER === 'console') {
    if (env.ENVIRONMENT !== 'development') {
      throw new Error('Console email driver cannot load outside development');
    }
    return consoleDriver;
  }
  throw new Error(`Unknown EMAIL_DRIVER: ${env.EMAIL_DRIVER}`);
}

// Send one email. Returns the provider's message id (or null). Throws on any
// failure, including a misconfigured driver.
//   options.replyTo: an address for replies; omitted → defaultReplyTo(env);
//                    null → no Reply-To header
export async function sendEmail(env, to, subject, bodyText, bodyHtml = '', { replyTo } = {}) {
  const driver = pickDriver(env);
  const htmlBody = bodyHtml || `<pre>${escapeHtml(bodyText)}</pre>`;
  let reply = replyTo === undefined ? defaultReplyTo(env) : replyTo;
  if (reply !== null && reply !== '') {
    reply = normaliseEmail(reply);
    if (!isValidEmail(reply)) throw new Error('sendEmail: replyTo is not a valid address');
  } else {
    reply = null;
  }
  try {
    return await driver(env, { to, subject, bodyText, bodyHtml: htmlBody, replyTo: reply });
  } catch (err) {
    logError('email_send_failed', err, { to: maskEmail(to) });
    throw err;
  }
}
