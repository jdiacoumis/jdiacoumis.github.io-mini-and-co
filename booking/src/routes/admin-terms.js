// Admin terms (Phase 2B — class-scheduling spec, design D1/D8): create a term
// generating its weekly sessions, edit dates/prices/plan options, re-run a
// term with auto-enrol, and the families × weeks term grid. Phase 1 registers
// the route with a placeholder page so later work never touches index.js.

import { html, pageResponse } from '../lib/html.js';
import { requireAdmin } from '../lib/middleware.js';

// GET /admin/terms
export async function handleAdminTerms(req, env) {
  const user = await requireAdmin(req, env);
  const body = html`
    <h1>Terms</h1>
    <p class="lede">Coming soon: create and edit terms, re-run a term for returning families, and the term grid.</p>
  `;
  return pageResponse('Terms', body, { user, admin: true });
}

export function registerRoutes(route) {
  route('GET', '/admin/terms', handleAdminTerms);
}
