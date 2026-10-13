// Admin email (Phase 2C — parent-comms spec, design D10): compose a message
// to a term's families (or its waitlist) and the email log. Phase 1 registers
// the route with a placeholder page so later work never touches index.js.

import { html, pageResponse } from '../lib/html.js';
import { requireAdmin } from '../lib/middleware.js';

// GET /admin/email
export async function handleAdminEmail(req, env) {
  const user = await requireAdmin(req, env);
  const body = html`
    <h1>Email</h1>
    <p class="lede">Coming soon: send a message to a term's families and see every email the system has sent.</p>
  `;
  return pageResponse('Email', body, { user, admin: true });
}

export function registerRoutes(route) {
  route('GET', '/admin/email', handleAdminEmail);
}
