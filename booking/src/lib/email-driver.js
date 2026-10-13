// Email driver: Resend (production) or a console outbox (local development).
//
// Fail-closed: an unknown EMAIL_DRIVER throws (it never silently falls back to
// the console outbox), and the console driver refuses to load outside
// ENVIRONMENT=development — so a misconfigured deploy fails loudly instead of
// "sending" magic links into a table nobody reads.
//
// Logging is PII-safe: masked recipient, truncated subject, never the body
// (magic links carry sign-in tokens).

import { logEvent, logError, maskEmail } from './log.js';
import { nowIso } from './db.js';
import { escapeHtml } from './html.js';

async function resendDriver(env, to, subject, bodyText, bodyHtml) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text: bodyText, html: bodyHtml }),
  });
  if (!response.ok) {
    // Security: the error body can echo the recipient — status only.
    throw new Error(`Resend failed (HTTP ${response.status})`);
  }
  const data = await response.json();
  logEvent('email_sent', { to: maskEmail(to), subject: subject.slice(0, 50), provider: 'resend' });
  return data.id || null;
}

// Development outbox: the dev_emails table, readable at /dev/mailbox.
async function consoleDriver(env, to, subject, bodyText, bodyHtml) {
  const result = await env.DB.prepare(
    `INSERT INTO dev_emails (to_email, subject, body_text, body_html, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(to, subject, bodyText, bodyHtml, nowIso()).run();
  logEvent('email_sent', { to: maskEmail(to), subject: subject.slice(0, 50), provider: 'console' });
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
export async function sendEmail(env, to, subject, bodyText, bodyHtml = '') {
  const driver = pickDriver(env);
  const htmlBody = bodyHtml || `<pre>${escapeHtml(bodyText)}</pre>`;
  try {
    return await driver(env, to, subject, bodyText, htmlBody);
  } catch (err) {
    logError('email_send_failed', err, { to: maskEmail(to), subject: String(subject).slice(0, 50) });
    throw err;
  }
}
