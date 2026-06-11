// Authentication routes: magic-link request, verification, logout, session lifecycle.

import { html, layout } from '../lib/html.js';
import { randomToken, sha256Hex, timingSafeEqual } from '../lib/crypto.js';
import { badRequest, forbidden, tooMany, redirect } from '../lib/http.js';
import { nowIso, isoPlusSeconds, uuid } from '../lib/db.js';
import { normaliseEmail, isValidEmail } from '../lib/validate.js';
import { sendEmail } from '../lib/email-driver.js';
import { createSession, sessionCookie, clearSessionCookie, getSessionIdFromCookies, getSession } from '../lib/session.js';
import { allowRate, clientIp } from '../lib/ratelimit.js';
import { logEvent, logError, maskEmail } from '../lib/log.js';

// GET /auth/request-magic-link — render the request form.
export async function handleRequestMagicLink(req, env) {
  const body = html`
    <h1>Sign In</h1>
    <p>Enter your email to receive a sign-in link.</p>
    <form method="post" action="/auth/request-magic-link">
      <input type="hidden" name="csrf" value="">
      <div class="form-group">
        <label for="email">Email address</label>
        <input type="email" id="email" name="email" required>
      </div>
      <button type="submit">Send sign-in link</button>
    </form>
  `;
  return new Response(layout('Sign In', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// POST /auth/request-magic-link — handle email submission, send link, rate-limited per email + IP.
export async function handleRequestMagicLinkPost(req, env) {
  const data = await req.formData();
  const email = normaliseEmail(data.get('email'));

  if (!isValidEmail(email)) {
    throw badRequest('That email address is not valid.');
  }

  // Rate limit per email and per IP: max 3 requests per hour.
  const ip = clientIp(req);
  const [emailAllowed, ipAllowed] = await Promise.all([
    allowRate(env, `auth:email:${email}`, 3, 3600),
    allowRate(env, `auth:ip:${ip}`, 5, 3600),
  ]);

  if (!emailAllowed || !ipAllowed) {
    logEvent('magic_link_rate_limit', { email: maskEmail(email), ip });
    throw tooMany('You have tried too many times. Please try again later.');
  }

  // Generate a 256-bit token and store only its hash with a 20-minute expiry.
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = nowIso();
  const expiresAt = isoPlusSeconds(20 * 60);

  await env.DB.prepare(
    `INSERT INTO auth_tokens (token_hash, email, purpose, expires_at, created_at)
     VALUES (?1, ?2, 'login', ?3, ?4)`,
  ).bind(tokenHash, email, expiresAt, now).run();

  logEvent('magic_link_requested', { email: maskEmail(email) });

  // Send the link via email.
  const link = `${env.PUBLIC_BASE_URL}/auth/verify?token=${encodeURIComponent(token)}`;
  const subject = 'Your Mini & Co. sign-in link';
  const bodyText = `Click this link to sign in: ${link}`;
  const bodyHtml = `<p>Click <a href="${link}">here</a> to sign in.</p><p>This link expires in 20 minutes.</p>`;

  try {
    await sendEmail(env, email, subject, bodyText, bodyHtml);
  } catch (err) {
    logError('magic_link_send_failed', err, { email: maskEmail(email) });
    // Don't expose the email delivery issue to the user; they can retry.
  }

  // Always show success (no enumeration).
  const body = html`
    <h1>Check your email</h1>
    <p>We've sent a sign-in link to ${email}. It expires in 20 minutes.</p>
    <p><a href="/auth/request-magic-link">Didn't get it? Request another link</a></p>
  `;
  return new Response(layout('Sign In', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// GET /auth/verify?token=... — verify the token and create a session.
export async function handleVerifyToken(req, env) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');

  if (!token || typeof token !== 'string' || token.length < 20) {
    throw badRequest('Invalid sign-in link.');
  }

  const tokenHash = await sha256Hex(token);
  const now = nowIso();

  // Atomically consume the token (mark as used).
  const result = await env.DB.prepare(
    `UPDATE auth_tokens
     SET used_at = ?1
     WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?3
     RETURNING email`,
  ).bind(now, tokenHash, now).first();

  if (!result) {
    logEvent('token_verification_failed', { token_hash: tokenHash.slice(0, 8) });
    throw badRequest('That sign-in link is no longer valid. Request a new one.');
  }

  const email = result.email;

  // Find or create the user (idempotent).
  const user = await env.DB.prepare(
    `SELECT id, role, name FROM users WHERE email = ?1`,
  ).bind(email).first();

  let userId;
  if (user) {
    userId = user.id;
    // Update last login.
    await env.DB.prepare(`UPDATE users SET last_login_at = ?1 WHERE id = ?2`)
      .bind(now, userId).run();
  } else {
    // Create new user (parent by default; admin status checked at login time).
    userId = uuid();
    const adminEmails = (env.ADMIN_EMAILS || '').split(',').map((e) => normaliseEmail(e));
    const isAdmin = adminEmails.includes(email) ? 1 : 0;

    await env.DB.prepare(
      `INSERT INTO users (id, email, role, created_at, last_login_at)
       VALUES (?1, ?2, ?, ?3, ?4)`,
    ).bind(userId, email, isAdmin ? 'admin' : 'parent', now, now).run();
  }

  // Create a new web session.
  const { sessionId } = await createSession(env, userId);

  logEvent('user_signed_in', {
    user_id: userId.slice(0, 8),
    email: maskEmail(email),
    new_user: !user,
  });

  // Redirect to account page with session cookie.
  const response = redirect('/account', 303);
  response.headers.set('Set-Cookie', sessionCookie(sessionId));
  return response;
}

// GET /auth/logout — destroy the session and redirect home.
export async function handleLogout(req, env) {
  const sessionId = getSessionIdFromCookies(req);
  if (sessionId) {
    const session = await getSession(env, sessionId);
    if (session) {
      await env.DB.prepare(`DELETE FROM web_sessions WHERE session_hash = ?1`)
        .bind(session.sessionHash).run();
      logEvent('user_signed_out', { user_id: session.userId.slice(0, 8) });
    }
  }

  const response = redirect('/', 303);
  response.headers.set('Set-Cookie', clearSessionCookie());
  return response;
}
