// Main Worker entry point: routing, security headers, static assets, errors.
//
// One Worker serves the whole site: requests matching static files are served
// from assets (the marketing site), and the dynamic booking routes below run
// against D1. Handlers either return a Response or throw — a thrown Response
// (redirect) or HttpError is rendered faithfully; anything else becomes a
// generic 500 with the detail kept in logs only.

import { html, layout } from './lib/html.js';
import { HttpError } from './lib/http.js';
import { logError } from './lib/log.js';
import {
  handleRequestMagicLink,
  handleRequestMagicLinkPost,
  handleVerifyToken,
  handleVerifyTokenPost,
  handleLogoutPage,
  handleLogoutPost,
} from './routes/auth.js';
import {
  handleListChildren,
  handleAddChild,
  handleAddChildPost,
  handleEditChild,
  handleEditChildPost,
  handleDeleteChild,
  handleDeleteChildPost,
} from './routes/child-profiles.js';
import {
  handleClassList,
  handleCheckout,
  handleCheckoutPost,
  handleConfirmPage,
  handleCancelledPage,
  handleBookingStatus,
} from './routes/booking.js';
import {
  handleAccountDashboard,
  handleProfile,
  handleProfilePost,
} from './routes/account.js';
import {
  handleAdminDashboard,
  handleAdminClasses,
  handleAdminClassNew,
  handleAdminClassNewPost,
  handleAdminClassEdit,
  handleAdminClassEditPost,
  handleAdminSessionNew,
  handleAdminSessionNewPost,
  handleAdminSessionEdit,
  handleAdminSessionEditPost,
  handleAdminRoster,
  handleAdminRosterCsv,
} from './routes/admin.js';
import {
  handleAdminBookings,
  handleAdminMarkPaid,
  handleAdminCancelBooking,
  handleAdminBookingsCsv,
  handleAdminCustomers,
} from './routes/admin-bookings.js';
import {
  handleImport,
  handleImportTemplate,
  handleImportPreview,
  handleImportCommit,
  handleImportInvites,
} from './routes/admin-import.js';
import { handleStripeWebhook } from './routes/webhooks.js';
import {
  handleMockCheckout,
  handleMockCheckoutPost,
  handleDevMailbox,
} from './routes/dev.js';

// Security headers applied to every dynamic response (defence in depth: CSP
// allows only same-origin scripts plus the Meta pixel, forms may only post to
// ourselves and Stripe Checkout, nothing may frame us).
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
    "form-action 'self' https://checkout.stripe.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "upgrade-insecure-requests",
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
// encoded separators can never reach a handler as an "id".

const routes = [];

function route(method, pattern, handler) {
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
  routes.push({ method, regex: new RegExp(`^${regexSource}/?$`), names, handler });
}

function matchRoute(method, pathname) {
  const effectiveMethod = method === 'HEAD' ? 'GET' : method;
  for (const r of routes) {
    if (r.method !== effectiveMethod) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.names.forEach((name, i) => { params[name] = m[i + 1]; });
    return { handler: r.handler, params };
  }
  return null;
}

// Authentication.
route('GET', '/auth/request-magic-link', handleRequestMagicLink);
route('POST', '/auth/request-magic-link', handleRequestMagicLinkPost);
route('GET', '/auth/verify', handleVerifyToken);
route('POST', '/auth/verify', handleVerifyTokenPost);
route('GET', '/auth/logout', handleLogoutPage);
route('POST', '/auth/logout', handleLogoutPost);

// Booking flow.
route('GET', '/book', handleClassList);
route('GET', '/book/checkout', handleCheckout);
route('POST', '/book/checkout', handleCheckoutPost);
route('GET', '/book/confirm', handleConfirmPage);
route('GET', '/book/cancelled', handleCancelledPage);

// Parent account.
route('GET', '/account', handleAccountDashboard);
route('GET', '/account/profile', handleProfile);
route('POST', '/account/profile', handleProfilePost);
route('GET', '/account/children', handleListChildren);
route('GET', '/account/children/new', handleAddChild);
route('POST', '/account/children/new', handleAddChildPost);
route('GET', '/account/children/:id/edit', handleEditChild);
route('POST', '/account/children/:id/edit', handleEditChildPost);
route('GET', '/account/children/:id/delete', handleDeleteChild);
route('POST', '/account/children/:id/delete', handleDeleteChildPost);

// Admin portal.
route('GET', '/admin', handleAdminDashboard);
route('GET', '/admin/classes', handleAdminClasses);
route('GET', '/admin/classes/new', handleAdminClassNew);
route('POST', '/admin/classes/new', handleAdminClassNewPost);
route('GET', '/admin/classes/:id/edit', handleAdminClassEdit);
route('POST', '/admin/classes/:id/edit', handleAdminClassEditPost);
route('GET', '/admin/sessions/new', handleAdminSessionNew);
route('POST', '/admin/sessions/new', handleAdminSessionNewPost);
route('GET', '/admin/sessions/:id/edit', handleAdminSessionEdit);
route('POST', '/admin/sessions/:id/edit', handleAdminSessionEditPost);
route('GET', '/admin/sessions/:id/roster', handleAdminRoster);
route('POST', '/admin/sessions/:id/roster.csv', handleAdminRosterCsv);
route('GET', '/admin/bookings', handleAdminBookings);
route('POST', '/admin/bookings/:id/mark-paid', handleAdminMarkPaid);
route('POST', '/admin/bookings/:id/cancel', handleAdminCancelBooking);
route('POST', '/admin/bookings.csv', handleAdminBookingsCsv);
route('GET', '/admin/customers', handleAdminCustomers);
route('GET', '/admin/import', handleImport);
route('GET', '/admin/import/template.csv', handleImportTemplate);
route('POST', '/admin/import/preview', handleImportPreview);
route('POST', '/admin/import/commit', handleImportCommit);
route('POST', '/admin/import/invites', handleImportInvites);

// APIs.
route('GET', '/api/health', async () => Response.json({ ok: true }));
route('GET', '/api/bookings/:id/status', handleBookingStatus);

// Stripe webhook (signature-verified; replay-protected).
route('POST', '/api/stripe/webhook', handleStripeWebhook);

// Development-only pages (404 in production — fail-closed inside each handler).
route('GET', '/dev/mock-checkout', handleMockCheckout);
route('POST', '/dev/mock-checkout', handleMockCheckoutPost);
route('GET', '/dev/mailbox', handleDevMailbox);

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
  async fetch(req, env) {
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
        const response = await match.handler(req, env, match.params);
        return withSecurityHeaders(response);
      }

      // No dynamic route matched → static assets (the marketing site).
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
};
