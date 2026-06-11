// Middleware for common request handling patterns.

import { getSessionIdFromCookies, getSession } from './session.js';
import { redirect } from './http.js';
import { logEvent } from './log.js';

// Require an authenticated session; redirect to login if missing.
export async function requireAuth(req, env) {
  const sessionId = getSessionIdFromCookies(req);
  if (!sessionId) {
    return null; // Not authenticated
  }

  const session = await getSession(env, sessionId);
  if (!session) {
    return null; // Session invalid or expired
  }

  const user = await env.DB.prepare(
    `SELECT id, email, role, name FROM users WHERE id = ?1`,
  ).bind(session.userId).first();

  if (!user) {
    return null; // User not found
  }

  return {
    userId: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    sessionHash: session.sessionHash,
    csrfToken: session.csrfToken,
  };
}

// Require authentication, redirecting to login if not authenticated.
export async function requireAuthOrRedirect(req, env) {
  const user = await requireAuth(req, env);
  if (!user) {
    throw redirect(`/auth/request-magic-link?next=${encodeURIComponent(req.url)}`);
  }
  return user;
}

// Require admin role.
export async function requireAdmin(req, env) {
  const user = await requireAuthOrRedirect(req, env);
  if (user.role !== 'admin') {
    logEvent('authz_denied', { user_id: user.userId.slice(0, 8), reason: 'not_admin' });
    throw { status: 403, publicMessage: 'You do not have access to that.' };
  }
  return user;
}

// Parse form data safely (POST requests).
export async function parseForm(req) {
  if (req.method !== 'POST') {
    throw { status: 405, publicMessage: 'Method not allowed.' };
  }

  const contentType = req.headers.get('Content-Type') || '';
  if (!contentType.includes('application/x-www-form-urlencoded') && !contentType.includes('multipart/form-data')) {
    throw { status: 415, publicMessage: 'Unsupported media type.' };
  }

  return req.formData();
}
