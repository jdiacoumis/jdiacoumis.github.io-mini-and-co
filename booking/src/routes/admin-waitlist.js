// Admin waitlist (Phase 2C — waitlist spec, design D7): each term's waitlist
// in join order, offers with a 48-hour hold, remove/decline. Phase 1 registers
// the route with a placeholder page so later work never touches index.js.

import { html, pageResponse } from '../lib/html.js';
import { requireAdmin } from '../lib/middleware.js';

// GET /admin/waitlist
export async function handleAdminWaitlist(req, env) {
  const user = await requireAdmin(req, env);
  const body = html`
    <h1>Waitlist</h1>
    <p class="lede">Coming soon: each term's waitlist in join order, with seat offers that hold a place for 48 hours.</p>
  `;
  return pageResponse('Waitlist', body, { user, admin: true });
}

export function registerRoutes(route) {
  route('GET', '/admin/waitlist', handleAdminWaitlist);
}
