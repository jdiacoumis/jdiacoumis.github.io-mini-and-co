// Main Worker entry point: routing, security headers, static assets, errors,
// and the scheduled (cron) handler.
//
// One Worker serves the whole site: requests matching staged static files
// (booking/public, see scripts/stage-assets.mjs) are served from assets, and
// the dynamic routes registered below run against D1. Handlers either return
// a Response or throw — a thrown Response (redirect) or HttpError is rendered
// faithfully; anything else becomes a generic 500 with the detail kept in
// logs only.
//
// Route modules register themselves: each exports registerRoutes(route) and
// calls route(method, pattern, handler). Adding a page never needs a change
// here. Handlers are called as handler(req, env, params, ctx).

import { html, layout } from './lib/html.js';
import { HttpError } from './lib/http.js';
import { logError } from './lib/log.js';
import { runJobs } from './lib/cron.js';
import * as auth from './routes/auth.js';
import * as childProfiles from './routes/child-profiles.js';
import * as booking from './routes/booking.js';
import * as waitlist from './routes/waitlist.js';
import * as account from './routes/account.js';
import * as admin from './routes/admin.js';
import * as adminBookings from './routes/admin-bookings.js';
import * as adminImport from './routes/admin-import.js';
import * as adminTerms from './routes/admin-terms.js';
import * as adminOps from './routes/admin-ops.js';
import * as adminWaitlist from './routes/admin-waitlist.js';
import * as adminEmail from './routes/admin-email.js';
import * as webhooks from './routes/webhooks.js';
import * as dev from './routes/dev.js';

const ROUTE_MODULES = [
  auth, childProfiles, booking, waitlist, account,
  admin, adminBookings, adminImport, adminTerms, adminOps, adminWaitlist, adminEmail,
  webhooks, dev,
];

// Security headers applied to every dynamic response (defence in depth: CSP
// allows only same-origin scripts plus the Meta pixel; forms may only post to
// ourselves and Stripe's hosted Checkout / Billing Portal (form-action also
// governs the redirect after a POST); nothing may frame us).
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://connect.facebook.net",
    "img-src 'self' https://www.facebook.com data:",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self' https://www.facebook.com https://connect.facebook.net",
    "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    'upgrade-insecure-requests',
  ].join('; '),
};

function errorPage(status, message) {
  const statusName = {
    400: 'Bad request',
    403: 'Not allowed',
    404: 'Not found',
    405: 'Method not allowed',
    409: 'Conflict',
    413: 'Too large',
    415: 'Unsupported',
    429: 'Too many requests',
    500: 'Something went wrong',
  }[status] || `Error ${status}`;

  const body = html`
    <div class="error-container">
      <h1>${status}</h1>
      <h2>${statusName}</h2>
      <p>${message}</p>
      <p><a href="/">Back to home</a></p>
    </div>
  `;

  return new Response(String(layout('Oops', body)), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// --- Router -----------------------------------------------------------------
// Patterns are literal paths with :name parameter segments. Parameters match
// one opaque-id-shaped segment only (no slashes, no dots), so traversal or
// encoded separators can never reach a handler as an "id". Literal routes
// always win over parameterised ones (/admin/bookings/new before
// /admin/bookings/:id), whatever order modules register them in.

const literalRoutes = [];
const paramRoutes = [];

function route(method, pattern, handler) {
  if (!['GET', 'POST'].includes(method)) throw new Error(`Unsupported route method: ${method}`);
  const names = [];
  const regexSource = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([A-Za-z0-9_-]{1,64})';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  (names.length ? paramRoutes : literalRoutes)
    .push({ method, regex: new RegExp(`^${regexSource}/?$`), names, handler });
}

function matchRoute(method, pathname) {
  const effectiveMethod = method === 'HEAD' ? 'GET' : method;
  for (const r of [...literalRoutes, ...paramRoutes]) {
    if (r.method !== effectiveMethod) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.names.forEach((name, i) => { params[name] = m[i + 1]; });
    return { handler: r.handler, params };
  }
  return null;
}

for (const module of ROUTE_MODULES) module.registerRoutes(route);
route('GET', '/api/health', async () => Response.json({ ok: true }));

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    try {
      // Reject path tricks before any routing (defence in depth — the asset
      // layer and the :id pattern are each strict on their own).
      if (url.pathname.includes('\\') || url.pathname.includes('//') || url.pathname.includes('..')) {
        return withSecurityHeaders(errorPage(404, 'We could not find that page.'));
      }

      if (!['GET', 'HEAD', 'POST'].includes(req.method)) {
        return withSecurityHeaders(errorPage(405, 'That method is not supported.'));
      }

      const match = matchRoute(req.method, url.pathname);
      if (match) {
        const response = await match.handler(req, env, match.params, ctx);
        return withSecurityHeaders(response);
      }

      // No dynamic route matched. Workers Assets answers requests for staged
      // files BEFORE the Worker runs (with the headers in public/_headers,
      // written by scripts/stage-assets.mjs) — so this only sees paths it
      // did not match, e.g. a method other than GET/HEAD; ask it once more
      // and turn its 404 into our page.
      const asset = await env.ASSETS.fetch(req);
      if (asset.status === 404) {
        return withSecurityHeaders(errorPage(404, 'We could not find that page.'));
      }
      return asset;
    } catch (err) {
      // Handlers throw Response objects for redirects (e.g. "sign in first").
      if (err instanceof Response) {
        return withSecurityHeaders(err);
      }
      if (err instanceof HttpError) {
        return withSecurityHeaders(errorPage(err.status, err.publicMessage));
      }

      logError('unhandled_error', err, { method: req.method, path: url.pathname });
      return withSecurityHeaders(errorPage(500, 'Something went wrong on our side. Please try again shortly.'));
    }
  },

  // Cron trigger (wrangler.toml [triggers]): every 15 minutes.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runJobs(env).catch((err) => logError('cron_run_failed', err, {})));
  },
};
