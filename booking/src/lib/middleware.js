// Middleware for common request handling patterns.

import { getSessionIdFromCookies, getSession, verifyCsrf } from './session.js';
import { HttpError, forbidden, redirect } from './http.js';
import { allowRate, clientIp } from './ratelimit.js';
import { logEvent } from './log.js';

// Resolve the authenticated user from the session cookie, or null.
export async function requireAuth(req, env) {
  const sessionId = getSessionIdFromCookies(req);
  if (!sessionId) return null;

  const session = await getSession(env, sessionId);
  if (!session) return null;

  const user = await env.DB.prepare(
    `SELECT id, email, role, name, phone FROM users WHERE id = ?1`,
  ).bind(session.userId).first();
  if (!user) return null;

  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    phone: user.phone,
    sessionHash: session.sessionHash,
    csrfToken: session.csrfToken,
  };
}

// Require authentication, redirecting to sign-in (preserving the destination
// as a same-site relative path — never the absolute URL) if not signed in.
export async function requireAuthOrRedirect(req, env) {
  const user = await requireAuth(req, env);
  if (!user) {
    const url = new URL(req.url);
    const next = url.pathname + url.search;
    throw redirect(`/auth/request-magic-link?next=${encodeURIComponent(next)}`);
  }
  return user;
}

// Require the admin role, re-checked server-side against the database on
// every request (no client-side or cookie-borne role claims are trusted).
// Denials are logged and rate limited so repeated probing is slowed down.
export async function requireAdmin(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  if (user.role !== 'admin') {
    logEvent('authz_denied', { user_id: user.userId.slice(0, 8), area: 'admin' });
    // Security: per-IP limit on repeated unauthorised admin probing (abuse
    // resistance); the response stays generic either way.
    await allowRate(env, `admin-denied:ip:${clientIp(req)}`, 20, 600);
    throw forbidden();
  }
  return user;
}

// CSRF defence for state-changing requests (CWE-352), layered:
//   1. Per-session random token embedded in every form, compared in constant
//      time against the token stored server-side with the session.
//   2. Origin header (when present) must match the request's own origin.
//   3. Sec-Fetch-Site (when present) must not be a cross-site value.
// SameSite=Lax on the session cookie is the final layer.
export function requireCsrf(req, user, form) {
  const url = new URL(req.url);
  const origin = req.headers.get('Origin');
  if (origin && origin !== url.origin) {
    logEvent('csrf_rejected', { reason: 'origin_mismatch' });
    throw forbidden('That request could not be verified. Please go back and try again.');
  }
  const fetchSite = req.headers.get('Sec-Fetch-Site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    logEvent('csrf_rejected', { reason: 'sec_fetch_site' });
    throw forbidden('That request could not be verified. Please go back and try again.');
  }
  if (!verifyCsrf(String(form.get('csrf') || ''), user.csrfToken)) {
    logEvent('csrf_rejected', { reason: 'token_mismatch' });
    throw forbidden('Your session has changed — please go back, refresh the page, and try again.');
  }
}

// Parse form data safely (POST requests), bounding body size so a single
// request cannot consume unbounded memory (CWE-400).
export async function parseForm(req, maxBytes = 64 * 1024) {
  if (req.method !== 'POST') {
    throw new HttpError(405, 'Method not allowed.');
  }

  const contentType = req.headers.get('Content-Type') || '';
  if (!contentType.includes('application/x-www-form-urlencoded') && !contentType.includes('multipart/form-data')) {
    throw new HttpError(415, 'Unsupported media type.');
  }

  const length = Number(req.headers.get('Content-Length') || 0);
  if (length > maxBytes) {
    throw new HttpError(413, 'That submission is too large.');
  }

  return req.formData();
}
