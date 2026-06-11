import { logEvent } from './log.js';

// Fixed-window rate limiting backed by D1. Good enough for a small site:
// windows are coarse but the limits below are far above any legitimate use.
//
// Security: applied per-email AND per-IP on authentication endpoints to slow
// brute force, token guessing and email-bombing (CWE-307 / API4).

export async function allowRate(env, key, limit, windowSecs) {
  const windowStart = String(Math.floor(Date.now() / 1000 / windowSecs) * windowSecs);
  const fullKey = `${key}:${windowSecs}`;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
  ).bind(fullKey, windowStart).first();
  const allowed = (row?.count ?? 1) <= limit;
  if (!allowed) logEvent('rate_limit_exceeded', { key: fullKey });
  return allowed;
}

// Opportunistic cleanup of stale windows; call occasionally from busy paths.
export async function sweepRateLimits(env) {
  const cutoff = String(Math.floor(Date.now() / 1000) - 24 * 3600);
  await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?1').bind(cutoff).run();
}

export function clientIp(request) {
  // CF-Connecting-IP is set by Cloudflare and not spoofable by clients;
  // fall back to a constant locally so dev rate limits still apply.
  return request.headers.get('CF-Connecting-IP') || 'local';
}
