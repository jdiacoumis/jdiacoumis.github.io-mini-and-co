// Main Worker entry point: handles routing, security headers, static assets, and error handling.

import { html, layout } from './lib/html.js';
import { HttpError, notFound, badRequest } from './lib/http.js';
import { logError } from './lib/log.js';
import {
  handleRequestMagicLink,
  handleRequestMagicLinkPost,
  handleVerifyToken,
  handleLogout,
} from './routes/auth.js';

// Security headers applied to all dynamic responses.
function securityHeaders() {
  return {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://connect.facebook.net https://checkout.stripe.com",
      "img-src 'self' https://www.facebook.com data:",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self'",
      "connect-src 'self' https://api.stripe.com https://graph.facebook.com",
      "form-action 'self' https://checkout.stripe.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "upgrade-insecure-requests",
    ].join('; '),
  };
}

// Render an error page.
function errorPage(status, message, details = '') {
  const statusName = {
    400: 'Bad Request',
    403: 'Forbidden',
    404: 'Not Found',
    429: 'Too Many Requests',
    500: 'Server Error',
  }[status] || `Error ${status}`;

  const body = html`
    <div class="error-container">
      <h1>${status}</h1>
      <h2>${statusName}</h2>
      <p>${message}</p>
      ${details ? html`<details><summary>Details</summary><pre>${details}</pre></details>` : ''}
      <p><a href="/">Back to home</a></p>
    </div>
  `;

  return new Response(layout('Error', body), {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...securityHeaders(),
    },
  });
}

// Simple router: (method, pathname) → handler.
const routes = new Map();

function route(method, pathPattern, handler) {
  const regex = new RegExp(`^${pathPattern}/?$`);
  routes.set(`${method} ${pathPattern}`, { regex, handler });
}

// Authentication routes.
route('GET', '/auth/request-magic-link', handleRequestMagicLink);
route('POST', '/auth/request-magic-link', handleRequestMagicLinkPost);
route('GET', '/auth/verify', handleVerifyToken);
route('GET', '/auth/logout', handleLogout);

// Stub routes for the booking flow (to be implemented in subsequent tasks).
route('GET', '/book/?', async (req, env) => {
  const body = html`
    <h1>Booking System</h1>
    <p>Coming soon. <a href="/">Back to home</a></p>
  `;
  return new Response(layout('Book', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders() },
  });
});

route('GET', '/account/?', async (req, env) => {
  const body = html`
    <h1>My Account</h1>
    <p>Coming soon. <a href="/">Back to home</a></p>
  `;
  return new Response(layout('Account', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders() },
  });
});

route('GET', '/admin/?', async (req, env) => {
  const body = html`
    <h1>Admin Portal</h1>
    <p>Coming soon. <a href="/">Back to home</a></p>
  `;
  return new Response(layout('Admin', body), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders() },
  });
});

// Health check endpoint.
route('GET', '/api/health', async (req, env) => {
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});

// Stripe webhook endpoint (stub).
route('POST', '/api/stripe/webhook', async (req, env) => {
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

// Find a route match and call its handler.
async function matchRoute(req, env) {
  const url = new URL(req.url);
  const key = `${req.method} ${url.pathname}`;

  for (const [pattern, { regex, handler }] of routes) {
    if (pattern.startsWith(`${req.method} `) && regex.test(url.pathname)) {
      return handler(req, env);
    }
  }

  // No route matched; serve static assets.
  const asset = await env.ASSETS.fetch(req);
  if (asset.status === 404) {
    return errorPage(404, 'We could not find that page.');
  }
  return asset;
}

// Main handler.
export default {
  async fetch(req, env, ctx) {
    try {
      // Check request validity.
      if (!req.method || !req.url) {
        return errorPage(400, 'Invalid request.');
      }

      // Block known attack patterns (path traversal, double-encoding, etc.).
      const url = new URL(req.url);
      if (
        url.pathname.includes('\\') ||
        url.pathname.includes('//') ||
        url.pathname.includes('..')
      ) {
        return errorPage(400, 'Invalid path.');
      }

      // Route the request.
      const response = await matchRoute(req, env);

      // Ensure dynamic responses have security headers.
      if (response.headers.get('Content-Type')?.includes('text/html')) {
        const newHeaders = new Headers(response.headers);
        Object.entries(securityHeaders()).forEach(([key, value]) => {
          if (!newHeaders.has(key)) newHeaders.set(key, value);
        });
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      }

      return response;
    } catch (err) {
      if (err instanceof HttpError) {
        return errorPage(err.status, err.publicMessage);
      }

      logError('unhandled_error', err, {
        url: req.url,
        method: req.method,
      });

      return errorPage(500, 'Something went wrong. We are looking into it.');
    }
  },
};
