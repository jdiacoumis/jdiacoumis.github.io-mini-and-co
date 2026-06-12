// Authentication routes: magic-link request, verification, sign-out.
//
// Security model (parent-auth spec):
//   * Passwordless: a 256-bit single-use token, stored only as a SHA-256 hash,
//     20-minute expiry, consumed atomically.
//   * Scanner-safe: the emailed link is a GET that only renders a "continue"
//     form; the token is consumed by the POST, so mail scanners that prefetch
//     links cannot burn them.
//   * No account enumeration: identical responses for known/unknown emails,
//     including when rate limited.
//   * Sign-out is a CSRF-protected POST with server-side session revocation.

import { html, pageResponse, csrfField } from '../lib/html.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';
import { badRequest, tooMany, redirect, safeNextPath } from '../lib/http.js';
import { nowIso, isoPlusSeconds, uuid } from '../lib/db.js';
import { normaliseEmail, isValidEmail } from '../lib/validate.js';
import { sendEmail } from '../lib/email-driver.js';
import { createSession, sessionCookie, clearSessionCookie } from '../lib/session.js';
import { requireAuth, requireCsrf, parseForm } from '../lib/middleware.js';
import { allowRate, clientIp } from '../lib/ratelimit.js';
import { logEvent, logError, maskEmail } from '../lib/log.js';

const TOKEN_TTL_SECS = 20 * 60;

// Create a single-use sign-in token for an email and send the magic link.
// Exported for reuse by the customer-migration invite flow.
export async function sendMagicLinkEmail(env, email, { next = '', purpose = 'login' } = {}) {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = nowIso();
  const expiresAt = isoPlusSeconds(TOKEN_TTL_SECS);

  await env.DB.prepare(
    `INSERT INTO auth_tokens (token_hash, email, purpose, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(tokenHash, email, purpose, expiresAt, now).run();

  const nextParam = next ? `&next=${encodeURIComponent(next)}` : '';
  const link = `${env.PUBLIC_BASE_URL}/auth/verify?token=${encodeURIComponent(token)}${nextParam}`;

  const isInvite = purpose === 'invite';
  const subject = isInvite
    ? 'Your Mini & Co. account has moved — sign in to get started'
    : 'Your Mini & Co. sign-in link';
  const intro = isInvite
    ? 'Our bookings have moved to our own website. Your details have come across with us — click the link below to sign in (no password needed), check your details, and see your classes.'
    : 'Click the link below to sign in to Mini & Co. Sensory Classes.';
  const bodyText = `${intro}\n\n${link}\n\nThis link can be used once and expires in 20 minutes. If you didn't request it, you can safely ignore this email.`;
  const bodyHtml = `<p>${intro}</p><p><a href="${link}">Sign in to Mini &amp; Co.</a></p><p>This link can be used once and expires in 20 minutes. If you didn't request it, you can safely ignore this email.</p>`;

  await sendEmail(env, email, subject, bodyText, bodyHtml);
}

function signInForm({ next = '', email = '', error = '' } = {}) {
  return html`
    <h1>Sign in</h1>
    <p class="lede">Enter your email and we'll send you a one-time sign-in link — no password needed.</p>
    ${error ? html`<p class="form-error" role="alert">${error}</p>` : ''}
    <form method="post" action="/auth/request-magic-link" class="booking-form">
      <input type="hidden" name="next" value="${next}">
      <div class="form-group">
        <label for="email">Email address</label>
        <input type="email" id="email" name="email" value="${email}" required autocomplete="email">
      </div>
      <button type="submit">Send sign-in link</button>
    </form>
  `;
}

// GET /auth/request-magic-link — render the request form.
export async function handleRequestMagicLink(req, env) {
  const url = new URL(req.url);
  const next = safeNextPath(url.searchParams.get('next'), '');
  return pageResponse('Sign in', signInForm({ next }));
}

// POST /auth/request-magic-link — send the link; rate-limited per email + IP.
export async function handleRequestMagicLinkPost(req, env) {
  const form = await parseForm(req);
  const email = normaliseEmail(form.get('email'));
  const next = safeNextPath(String(form.get('next') || ''), '');

  if (!isValidEmail(email)) {
    return pageResponse('Sign in', signInForm({
      next,
      email: String(form.get('email') || '').slice(0, 254),
      error: 'That does not look like a valid email address — expected something like name@example.com.',
    }), { status: 400 });
  }

  // Security: per-email and per-IP fixed-window limits slow brute force and
  // email bombing (CWE-307). The refusal is generic for known and unknown
  // addresses alike, so it cannot be used for account enumeration.
  const ip = clientIp(req);
  const [emailAllowed, ipAllowed] = await Promise.all([
    allowRate(env, `auth:email:${email}`, 3, 3600),
    allowRate(env, `auth:ip:${ip}`, 10, 3600),
  ]);
  if (!emailAllowed || !ipAllowed) {
    logEvent('magic_link_rate_limit', { email: maskEmail(email) });
    throw tooMany();
  }

  // Only send to registered accounts — but respond identically either way
  // (no enumeration). New parents are created at first sign-in via invite or
  // by signing in once; self-serve sign-up happens through this same flow,
  // so unknown emails DO get an account-creating link.
  try {
    await sendMagicLinkEmail(env, email, { next });
    logEvent('magic_link_requested', { email: maskEmail(email) });
  } catch (err) {
    logError('magic_link_send_failed', err, { email: maskEmail(email) });
    // Swallow: the user-facing response must not reveal delivery internals.
  }

  const body = html`
    <h1>Check your email</h1>
    <p class="lede">If everything is in order, a sign-in link is on its way to <strong>${email}</strong>. It can be used once and expires in 20 minutes.</p>
    <p>Nothing arrived after a couple of minutes? Check your spam folder, or <a href="/auth/request-magic-link">request another link</a>.</p>
  `;
  return pageResponse('Check your email', body);
}

const GENERIC_TOKEN_FAILURE = html`
  <h1>That link didn't work</h1>
  <p class="lede">The sign-in link is no longer valid — it may have expired or already been used.</p>
  <p><a href="/auth/request-magic-link">Request a fresh sign-in link</a> — it only takes a moment.</p>
`;

// GET /auth/verify?token=…&next=… — render a confirmation form WITHOUT
// consuming the token. Email security scanners prefetch GET links; the token
// is only consumed by the explicit POST below.
export async function handleVerifyToken(req, env) {
  const url = new URL(req.url);
  const token = String(url.searchParams.get('token') || '');
  const next = safeNextPath(url.searchParams.get('next'), '');

  if (token.length < 20 || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return pageResponse('Sign in', GENERIC_TOKEN_FAILURE, { status: 400 });
  }

  const body = html`
    <h1>Almost there</h1>
    <p class="lede">Click below to finish signing in to Mini &amp; Co.</p>
    <form method="post" action="/auth/verify" class="booking-form">
      <input type="hidden" name="token" value="${token}">
      <input type="hidden" name="next" value="${next}">
      <button type="submit">Sign in</button>
    </form>
  `;
  return pageResponse('Sign in', body);
}

// POST /auth/verify — atomically consume the token and establish a session.
export async function handleVerifyTokenPost(req, env) {
  const form = await parseForm(req);
  const token = String(form.get('token') || '');
  const next = safeNextPath(String(form.get('next') || ''), '/account');

  // Security: per-IP throttle on verification attempts stops token guessing;
  // the refusal never reveals how close an attempt was (CWE-307).
  if (!(await allowRate(env, `verify:ip:${clientIp(req)}`, 10, 900))) {
    throw tooMany();
  }

  if (token.length < 20 || token.length > 200) {
    return pageResponse('Sign in', GENERIC_TOKEN_FAILURE, { status: 400 });
  }

  const tokenHash = await sha256Hex(token);
  const now = nowIso();

  // Atomic single-use consumption: the UPDATE only matches an unused, unexpired
  // row, so two concurrent attempts with the same token cannot both succeed.
  const consumed = await env.DB.prepare(
    `UPDATE auth_tokens
     SET used_at = ?1
     WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?3
     RETURNING email`,
  ).bind(now, tokenHash, now).first();

  if (!consumed) {
    logEvent('token_verification_failed', {});
    return pageResponse('Sign in', GENERIC_TOKEN_FAILURE, { status: 400 });
  }

  const email = consumed.email;

  // The admin role comes ONLY from the server-side allowlist, re-derived at
  // every sign-in (covers both promotion and demotion). There is no
  // self-service path to admin (parent-auth spec).
  const adminEmails = String(env.ADMIN_EMAILS || '').split(',').map((e) => normaliseEmail(e)).filter(Boolean);
  const role = adminEmails.includes(email) ? 'admin' : 'parent';

  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE email = ?1`,
  ).bind(email).first();

  let userId;
  if (existing) {
    userId = existing.id;
    await env.DB.prepare(
      `UPDATE users SET role = ?1, last_login_at = ?2 WHERE id = ?3`,
    ).bind(role, now, userId).run();
  } else {
    userId = uuid();
    await env.DB.prepare(
      `INSERT INTO users (id, email, role, created_at, last_login_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(userId, email, role, now, now).run();
  }

  // Fresh session id at every sign-in (never reuse a pre-auth identifier).
  const { sessionId } = await createSession(env, userId);

  logEvent('user_signed_in', {
    user_id: userId.slice(0, 8),
    email: maskEmail(email),
    new_user: !existing,
  });

  const response = redirect(next, 303);
  response.headers.set('Set-Cookie', sessionCookie(sessionId));
  return response;
}

// GET /auth/logout — confirmation page (sign-out itself must be a POST).
export async function handleLogoutPage(req, env) {
  const user = await requireAuth(req, env);
  if (!user) return redirect('/', 303);

  const body = html`
    <h1>Sign out</h1>
    <form method="post" action="/auth/logout" class="booking-form">
      ${csrfField(user.csrfToken)}
      <button type="submit">Sign out</button>
    </form>
  `;
  return pageResponse('Sign out', body, { user });
}

// POST /auth/logout — CSRF-protected, revokes the session server-side so any
// captured cookie copy is unusable afterwards, then clears the cookie.
export async function handleLogoutPost(req, env) {
  const user = await requireAuth(req, env);
  const response = redirect('/', 303);
  response.headers.set('Set-Cookie', clearSessionCookie());

  if (user) {
    const form = await parseForm(req);
    requireCsrf(req, user, form);
    await env.DB.prepare(`DELETE FROM web_sessions WHERE session_hash = ?1`)
      .bind(user.sessionHash).run();
    logEvent('user_signed_out', { user_id: user.userId.slice(0, 8) });
  }

  return response;
}
