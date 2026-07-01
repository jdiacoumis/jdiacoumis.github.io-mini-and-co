// Email driver: resend (production) or console-with-dev-outbox (local).
// Sends transactional emails (magic links, confirmations, invites).

import { logEvent, logError } from './log.js';
import { nowIso } from './db.js';

async function resendDriver(env, to, subject, bodyText, bodyHtml) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to,
      subject,
      text: bodyText,
      html: bodyHtml,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Resend failed (${response.status}): ${error}`);
  }

  const data = await response.json();
  logEvent('email_sent', {
    to: to.split('@')[0] ? `${to[0]}***@${to.split('@')[1]}` : 'invalid',
    subject: subject.slice(0, 50),
    provider: 'resend',
    message_id: data.id,
  });
}

async function consoleDriver(env, to, subject, bodyText, bodyHtml) {
  const now = nowIso();
  const result = await env.DB.prepare(
    `INSERT INTO dev_emails (to_email, subject, body_text, body_html, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(to, subject, bodyText, bodyHtml, now).run();

  if (!result.success) {
    throw new Error('Failed to insert dev email');
  }

  logEvent('email_sent', {
    to: to.split('@')[0] ? `${to[0]}***@${to.split('@')[1]}` : 'invalid',
    subject: subject.slice(0, 50),
    provider: 'console',
  });

  // Also log to console for immediate visibility during dev.
  console.log(`\n📧 Email to ${to}:\nSubject: ${subject}\n${bodyText}\n`);
}

export async function sendEmail(env, to, subject, bodyText, bodyHtml = '') {
  if (!bodyHtml) bodyHtml = `<pre>${escapeHtml(bodyText)}</pre>`;

  try {
    const driver = env.EMAIL_DRIVER === 'resend' ? resendDriver : consoleDriver;
    await driver(env, to, subject, bodyText, bodyHtml);
  } catch (err) {
    logError('email_send_failed', err, {
      to: to.split('@')[0] ? `${to[0]}***@${to.split('@')[1]}` : 'invalid',
      subject: subject.slice(0, 50),
    });
    throw err;
  }
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text || '').replace(/[&<>"']/g, (ch) => map[ch]);
}
