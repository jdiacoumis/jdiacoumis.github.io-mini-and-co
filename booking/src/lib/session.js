// Web session management (cookie-based, server-side validated).
// Sessions store user id, CSRF token, and expiry. The cookie holds a 256-bit
// session id; only its SHA-256 hash is stored in the database, so a DB leak
// doesn't compromise active sessions.

import { randomToken, sha256Hex, timingSafeEqual } from './crypto.js';
import { isoPlusSeconds, nowIso } from './db.js';
import { maskEmail, logEvent } from './log.js';

const SESSION_ID_COOKIE = 'session';
const SESSION_DURATION_SECS = 30 * 24 * 3600; // 30 days absolute expiry
const SESSION_GRACE_SECS = 60; // grace period for clock skew

export async function createSession(env, userId) {
  const sessionId = randomToken();
  const sessionHash = await sha256Hex(sessionId);
  const csrfToken = randomToken();
  const now = nowIso();
  const expiresAt = isoPlusSeconds(SESSION_DURATION_SECS);

  await env.DB.prepare(
    `INSERT INTO web_sessions (session_hash, user_id, csrf_token, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(sessionHash, userId, csrfToken, now, expiresAt).run();

  logEvent('session_created', { session_id: sessionHash.slice(0, 8) });

  return { sessionId, sessionHash, csrfToken };
}

export async function getSession(env, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length < 20) return null;

  const sessionHash = await sha256Hex(sessionId);
  const now = nowIso();

  const row = await env.DB.prepare(
    `SELECT user_id, csrf_token, created_at, expires_at FROM web_sessions
     WHERE session_hash = ?1 AND expires_at > datetime(?2, '-${SESSION_GRACE_SECS} seconds')`,
  ).bind(sessionHash, now).first();

  if (!row) return null;

  return {
    userId: row.user_id,
    csrfToken: row.csrf_token,
    sessionHash,
  };
}

export async function deleteSession(env, sessionHash) {
  await env.DB.prepare(
    `DELETE FROM web_sessions WHERE session_hash = ?1`,
  ).bind(sessionHash).run();

  logEvent('session_deleted', { session_id: sessionHash.slice(0, 8) });
}

export function sessionCookie(sessionId, maxAge = SESSION_DURATION_SECS) {
  return `${SESSION_ID_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookie() {
  return `${SESSION_ID_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// Extract session id from request cookies.
export function getSessionIdFromCookies(request) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === SESSION_ID_COOKIE) return value;
  }
  return null;
}

// CSRF protection: verify token matches the one stored in the session.
export function verifyCsrf(formToken, sessionToken) {
  if (typeof formToken !== 'string' || typeof sessionToken !== 'string') return false;
  return timingSafeEqual(formToken, sessionToken);
}
